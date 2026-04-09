// tests/agents/runner-web-search.test.ts
// Tests WRITER web search tool injection in runner (TU-Phase3).
// Verifies ToolInjectionLLMClient is wired when enable_web_search: true,
// tool_call_progress SSE is emitted, and tool_calls_trace is persisted.
//
// Mocks: fetch (network), @/lib/db/client, projectEventBus.

// ─── Global mocks — must be before imports ────────────────────────────────────

const mockFetch = jest.fn()
global.fetch = mockFetch

// Named with 'mock' prefix so jest factory scope allows it
let mockDbState: {
  runConfig: Record<string, unknown>
  capturedEvents: unknown[]
  nodeUpdates: Array<{ id: string; data: unknown }>
}

jest.mock('@/lib/db/client', () => ({
  get db() { return mockDb },
}))

jest.mock('@/lib/events/project-event-bus.factory', () => ({
  projectEventBus: {
    emit: jest.fn(async (e: unknown) => {
      mockDbState?.capturedEvents.push(e)
    }),
  },
}))

// Must also stub the SSRF guard that web-search.ts imports
jest.mock('@/lib/security/ssrf-protection', () => ({
  assertNotPrivateHost: jest.fn(async () => {}),
}))

// ─── Imports (after mock declarations) ───────────────────────────────────────

import { makeAgentRunner } from '@/lib/agents/runner'
import { MockLLMClient }   from '@/lib/llm/mock-client'
import type { NodeRow }    from '@/lib/execution/engine.interface'

// ─── DB stub ─────────────────────────────────────────────────────────────────

const mockDb = {
  run: {
    findUnique: jest.fn(async ({ select }: { where: { id: string }; select?: Record<string, boolean> }) => {
      if (select && ('run_config' in select || 'project_id' in select)) {
        return { run_config: mockDbState.runConfig, project_id: 'proj-ws-001' }
      }
      // dag lookup (for upstream context snapshot)
      return { dag: { nodes: [], edges: [] } }
    }),
  },
  node: {
    findMany: jest.fn(async () => []),
    update:   jest.fn(async ({ where, data }: { where: { id: string }; data: unknown }) => {
      mockDbState.nodeUpdates.push({ id: where.id, data })
      return {}
    }),
  },
  sourceTrustEvent: {
    createMany: jest.fn(async () => ({ count: 1 })),
  },
  runArtifact: {
    // not called in these tests (no output_file_format)
    create: jest.fn(async () => ({ id: 'art-000', artifact_role: 'pending_review' })),
  },
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal WRITER node row */
function makeWriterNode(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id:               'node-db-id-001',
    run_id:           'run-ws-001',
    node_id:          'n2',
    agent_type:       'WRITER',
    status:           'RUNNING',
    started_at:       null,
    completed_at:     null,
    interrupted_at:   null,
    interrupted_by:   null,
    last_heartbeat:   null,
    retries:          0,
    handoff_in:       null,
    handoff_out:      null,
    partial_output:   null,
    partial_updated_at: null,
    cost_usd:         0,
    tokens_in:        0,
    tokens_out:       0,
    error:            null,
    metadata: {
      description:          'Write a summary of renewable energy',
      complexity:           'medium',
      expected_output_type: 'document',
      domain_profile:       'research_synthesis',
    },
    ...overrides,
  }
}

/** Valid WriterOutput JSON that the mock LLM will return */
function makeWriterResponse() {
  return JSON.stringify({
    output: {
      type:                 'document',
      summary:              'A summary of renewable energy trends',
      content:              '# Renewable Energy\n\nSolar and wind are growing fast.',
      confidence:           88,
      confidence_rationale: 'Search results confirmed current data.',
    },
    assumptions_made: ['Data from 2024'],
  })
}

/** Fake Brave search API response */
function fakeBraveSearchResponse(query: string) {
  return {
    ok:     true,
    status: 200,
    json: async () => ({
      web: {
        results: [
          { title: 'Solar Growth', url: 'https://example.com/solar', description: `Results for "${query}"` },
          { title: 'Wind Energy', url: 'https://example.com/wind',  description: 'Wind capacity doubled' },
        ],
      },
    }),
  } as unknown as Response
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  mockDbState = { runConfig: {}, capturedEvents: [], nodeUpdates: [] }
  mockFetch.mockResolvedValue(fakeBraveSearchResponse('test'))
  // Provide a fake API key so searchBrave() doesn't throw before hitting fetch
  process.env['BRAVE_SEARCH_API_KEY'] = 'test-brave-key-mock'
})

describe('WRITER with enable_web_search: true', () => {
  it('uses ToolInjectionLLMClient, emits tool_call_progress SSE, and persists tool_calls_trace', async () => {
    // Setup: run_config with web search enabled
    mockDbState.runConfig = { enable_web_search: true }

    const llm = new MockLLMClient()
    // Queue a web_search tool call, then the final writer response
    llm.setNextToolCallResponse(
      [{ id: 'tc-1', name: 'web_search', input: { query: 'renewable energy trends 2024', max_results: 3 } }],
      makeWriterResponse(),
    )

    const runner  = makeAgentRunner(llm)
    const node    = makeWriterNode()
    const signal  = new AbortController().signal

    const result = await runner(node, null, signal)

    // Writer handoffOut should contain the output
    const handoff = result.handoffOut as Record<string, unknown>
    expect(handoff).toBeDefined()
    expect((handoff['output'] as Record<string, unknown>)['content']).toContain('Renewable Energy')

    // tool_calls_trace should be in the handoff execution_meta
    const execMeta = handoff['execution_meta'] as Record<string, unknown>
    expect(execMeta).toBeDefined()
    expect(Array.isArray(execMeta['tool_calls_trace'])).toBe(true)
    const trace = execMeta['tool_calls_trace'] as Array<Record<string, unknown>>
    expect(trace).toHaveLength(1)
    expect(trace[0]!['iteration']).toBe(1)

    // SSE tool_call_progress should have been emitted
    const sseEvents = mockDbState.capturedEvents as Array<{
      event: { type: string; tool_name?: string; is_error: boolean; result_count?: number }
    }>
    const toolCallEvents = sseEvents.filter(e => e.event.type === 'tool_call_progress')
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1)
    const firstToolEvent = toolCallEvents[0]!.event
    expect(firstToolEvent.tool_name).toBe('web_search')
    expect(firstToolEvent.is_error).toBe(false)
    expect(typeof firstToolEvent.result_count).toBe('number')

    // Node.metadata should contain tool_calls_trace
    const metaUpdate = mockDbState.nodeUpdates.find(u => u.id === node.id)
    expect(metaUpdate).toBeDefined()
    const updatedMeta = metaUpdate!.data as { metadata: Record<string, unknown> }
    expect(Array.isArray(updatedMeta.metadata['tool_calls_trace'])).toBe(true)
  })
})

describe('WRITER with enable_web_search: false (default)', () => {
  it('uses contextualLlm without tool injection — no tool_calls_trace, no SSE', async () => {
    // Default: no enable_web_search
    mockDbState.runConfig = { enable_web_search: false }

    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterResponse())

    const runner = makeAgentRunner(llm)
    const node   = makeWriterNode()
    const signal = new AbortController().signal

    const result = await runner(node, null, signal)

    const handoff  = result.handoffOut as Record<string, unknown>
    const execMeta = handoff['execution_meta'] as Record<string, unknown>

    // No tool_calls_trace when web search disabled
    expect(execMeta['tool_calls_trace']).toBeUndefined()

    // No tool_call_progress SSE events
    const sseEvents = mockDbState.capturedEvents as Array<{ event: { type: string } }>
    const toolCallEvents = sseEvents.filter(e => e.event.type === 'tool_call_progress')
    expect(toolCallEvents).toHaveLength(0)

    // No node metadata update for tool_calls_trace
    const metaUpdate = mockDbState.nodeUpdates.find(u => u.id === node.id)
    expect(metaUpdate).toBeUndefined()
  })

  it('treats missing run_config as web search disabled (backward compat)', async () => {
    // run_config is an empty object (old runs that pre-date web search feature)
    mockDbState.runConfig = {}

    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterResponse())

    const runner = makeAgentRunner(llm)
    const node   = makeWriterNode()
    const signal = new AbortController().signal

    const result = await runner(node, null, signal)

    const handoff  = result.handoffOut as Record<string, unknown>
    const execMeta = handoff['execution_meta'] as Record<string, unknown>

    // Should work normally — no crash, no tools
    expect(handoff['source_agent']).toBe('WRITER')
    expect(execMeta['tool_calls_trace']).toBeUndefined()
  })
})

// ─── D5: anthropicNativeWebSearch flag ────────────────────────────────────────

describe('WRITER with enable_web_search: true — anthropicNativeWebSearch flag', () => {
  it('passes anthropicNativeWebSearch:true in ChatOptions when enable_web_search is set', async () => {
    // This test verifies that Writer forwards the flag regardless of the underlying
    // provider — the actual Anthropic native path is exercised in lib/llm/client.ts
    // unit tests. Here we assert the contract at the runner/writer boundary.
    mockDbState.runConfig = { enable_web_search: true }

    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterResponse())

    const runner = makeAgentRunner(llm)
    const node   = makeWriterNode()
    const signal = new AbortController().signal

    await runner(node, null, signal)

    // MockLLMClient records all calls in llm.calls
    expect(llm.calls.length).toBeGreaterThanOrEqual(1)
    // At least one call must have anthropicNativeWebSearch: true
    const hasNativeFlag = llm.calls.some(
      (c) => (c.options as unknown as Record<string, unknown>)['anthropicNativeWebSearch'] === true,
    )
    expect(hasNativeFlag).toBe(true)
  })

  it('passes anthropicNativeWebSearch:false when enable_web_search is not set', async () => {
    mockDbState.runConfig = {}

    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterResponse())

    const runner = makeAgentRunner(llm)
    const node   = makeWriterNode()
    const signal = new AbortController().signal

    await runner(node, null, signal)

    // All calls must have anthropicNativeWebSearch: false (or absent)
    const hasNativeFlag = llm.calls.some(
      (c) => (c.options as unknown as Record<string, unknown>)['anthropicNativeWebSearch'] === true,
    )
    expect(hasNativeFlag).toBe(false)
  })
})

