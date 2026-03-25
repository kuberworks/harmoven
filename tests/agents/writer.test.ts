// tests/agents/writer.test.ts
// Unit tests for Writer — 2 happy path scenarios + edge cases.
// Uses MockLLMClient — zero network / LLM cost.

import { Writer } from '@/lib/agents/writer'
import { MockLLMClient } from '@/lib/llm/mock-client'
import type { WriterNodeInput } from '@/lib/agents/writer'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWriterPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    output: {
      type: 'code',
      summary: 'Next.js project scaffolded with auth and a database schema.',
      content: '// Generated code...',
      confidence: 91,
      confidence_rationale: 'All required files generated.',
    },
    assumptions_made: [
      'SQLite chosen per app_scaffolding default stack',
      'Email auth only — no OAuth provider specified',
    ],
    ...overrides,
  })
}

function makeNode(overrides: Partial<WriterNodeInput> = {}): WriterNodeInput {
  return {
    node_id: 'n1',
    description: 'Scaffold Next.js project with auth and DB schema',
    complexity: 'high',
    expected_output_type: 'code',
    inputs: {},
    domain_profile: 'app_scaffolding',
    run_id: 'run-test-001',
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Writer', () => {
  it('executes a high-complexity node using the powerful LLM tier', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterPayload())

    const writer = new Writer(llm)
    const result = await writer.execute(makeNode({ complexity: 'high' }))

    expect(result.source_agent).toBe('WRITER')
    expect(result.source_node_id).toBe('n1')
    expect(result.target_agent).toBe('REVIEWER')
    expect(result.run_id).toBe('run-test-001')

    // Output fields
    expect(result.output.type).toBe('code')
    expect(result.output.confidence).toBe(91)
    expect(result.output.summary).toContain('Next.js')

    // Assumptions captured
    expect(result.assumptions_made).toHaveLength(2)
    expect(result.assumptions_made[0]).toContain('SQLite')

    // Execution meta
    expect(result.lateral_delegation_request).toBeNull()
    expect(result.execution_meta.llm_used).toBe('powerful')
    expect(result.execution_meta.tokens_input).toBeGreaterThan(0)
    expect(result.execution_meta.tokens_output).toBeGreaterThan(0)

    // Correct tier passed to LLM
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].options.model).toBe('powerful')
  })

  it('executes a low-complexity node using the fast LLM tier', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify({
        output: {
          type: 'document',
          summary: 'HANDOFF_NOTE.md written with assumptions and next steps.',
          content: '# What was created\nA Next.js app...',
          confidence: 95,
          confidence_rationale: 'Simple document, task clear.',
        },
        assumptions_made: [],
      }),
    )

    const writer = new Writer(llm)
    const result = await writer.execute(
      makeNode({
        node_id: 'n3',
        description: 'Write HANDOFF_NOTE.md',
        complexity: 'low',
        expected_output_type: 'document',
      }),
    )

    expect(result.output.type).toBe('document')
    expect(result.output.confidence).toBe(95)
    expect(result.assumptions_made).toHaveLength(0)
    expect(result.execution_meta.llm_used).toBe('fast')

    expect(llm.calls[0].options.model).toBe('fast')
  })

  it('uses balanced tier for medium-complexity node', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterPayload())

    const writer = new Writer(llm)
    await writer.execute(makeNode({ complexity: 'medium' }))

    expect(llm.calls[0].options.model).toBe('balanced')
  })

  it('forwards chunks via onChunk callback (streaming)', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterPayload())

    const chunks: string[] = []
    const writer = new Writer(llm)
    const result = await writer.execute(makeNode(), undefined, chunk => chunks.push(chunk))

    // MockLLMClient emits content as a single chunk
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('Next.js')
    expect(result.output.confidence).toBe(91)
  })

  it('throws on invalid JSON from LLM', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse('not valid json')

    const writer = new Writer(llm)
    await expect(writer.execute(makeNode())).rejects.toThrow(
      'Writer(n1): LLM returned invalid JSON',
    )
  })

  it('passes task description and upstream inputs in user message', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(makeWriterPayload())

    const writer = new Writer(llm)
    await writer.execute(
      makeNode({
        description: 'Build reservation booking UI',
        inputs: { 'output:n1': { summary: 'Scaffold done' } },
      }),
    )

    const userMsg = llm.calls[0].messages[1]
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toContain('reservation booking UI')
    expect(userMsg.content).toContain('output:n1')
  })
})
