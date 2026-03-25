// tests/agents/reviewer.test.ts
// Unit tests for Reviewer — 2 happy path scenarios + edge cases.
// Uses MockLLMClient — zero network / LLM cost.

import { Reviewer } from '@/lib/agents/reviewer'
import { MockLLMClient } from '@/lib/llm/mock-client'
import type { WriterOutput } from '@/lib/agents/writer'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWriterOutput(node_id: string, overrides: Partial<WriterOutput['output']> = {}): WriterOutput {
  return {
    handoff_version: '1.0',
    source_agent: 'WRITER',
    source_node_id: node_id,
    target_agent: 'REVIEWER',
    run_id: 'run-test-001',
    output: {
      type: 'code',
      summary: `Output from ${node_id}`,
      content: `// code for ${node_id}`,
      confidence: 90,
      confidence_rationale: 'Clean output.',
      ...overrides,
    },
    assumptions_made: ['Default stack used'],
    execution_meta: {
      llm_used: 'powerful',
      tokens_input: 1000,
      tokens_output: 500,
      duration_seconds: 10,
      retries: 0,
    },
    lateral_delegation_request: null,
  }
}

function makeReviewerPayload(verdict: string, findings: unknown[] = [], confidence = 89) {
  return JSON.stringify({
    verdict,
    findings,
    overall_confidence: confidence,
    overall_confidence_rationale: 'Review complete.',
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Reviewer', () => {
  it('returns APPROVE verdict with no findings for clean output', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(makeReviewerPayload('APPROVE', [], 92))

    const reviewer = new Reviewer(llm)
    const result = await reviewer.review(
      [makeWriterOutput('n1'), makeWriterOutput('n2')],
      'app_scaffolding',
      'run-test-001',
    )

    expect(result.source_agent).toBe('REVIEWER')
    expect(result.target).toBe('HUMAN_GATE')
    expect(result.run_id).toBe('run-test-001')
    expect(result.verdict).toBe('APPROVE')
    expect(result.findings).toHaveLength(0)
    expect(result.overall_confidence).toBe(92)

    // Reviewer must always use powerful tier
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].options.model).toBe('powerful')
  })

  it('returns REQUEST_REVISION with error findings', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      makeReviewerPayload(
        'REQUEST_REVISION',
        [
          {
            severity: 'error',
            node_id: 'n1',
            issue: 'NEXTAUTH_SECRET missing from .env.example',
            recommendation: 'Add NEXTAUTH_SECRET placeholder with generation instructions',
          },
          {
            severity: 'warning',
            node_id: 'n2',
            issue: 'No seed data provided for demonstration',
            recommendation: 'Add a seed script with sample reservations',
          },
        ],
        72,
      ),
    )

    const reviewer = new Reviewer(llm)
    const result = await reviewer.review(
      [makeWriterOutput('n1'), makeWriterOutput('n2')],
      'app_scaffolding',
      'run-test-001',
    )

    expect(result.verdict).toBe('REQUEST_REVISION')
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0].severity).toBe('error')
    expect(result.findings[0].node_id).toBe('n1')
    expect(result.findings[1].severity).toBe('warning')
    expect(result.overall_confidence).toBe(72)
  })

  it('passes all writer outputs in the user message', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(makeReviewerPayload('APPROVE'))

    const reviewer = new Reviewer(llm)
    await reviewer.review(
      [makeWriterOutput('n1'), makeWriterOutput('n2')],
      'marketing_content',
      'run-test-002',
    )

    const userMsg = llm.calls[0].messages[1]
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toContain('n1')
    expect(userMsg.content).toContain('n2')
    expect(userMsg.content).toContain('marketing_content')
    expect(userMsg.content).toContain('run-test-002')
  })

  it('throws on invalid JSON from LLM', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse('broken json {{')

    const reviewer = new Reviewer(llm)
    await expect(
      reviewer.review([makeWriterOutput('n1')], 'generic', 'run-err'),
    ).rejects.toThrow('Reviewer: LLM returned invalid JSON')
  })

  it('throws on invalid verdict value', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify({
        verdict: 'RUBBER_STAMP',
        findings: [],
        overall_confidence: 99,
        overall_confidence_rationale: 'All good.',
      }),
    )

    const reviewer = new Reviewer(llm)
    await expect(
      reviewer.review([makeWriterOutput('n1')], 'generic', 'run-err'),
    ).rejects.toThrow('Reviewer: invalid verdict')
  })
})
