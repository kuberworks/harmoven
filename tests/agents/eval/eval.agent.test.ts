// tests/agents/eval/eval.agent.test.ts
// Unit tests for EvalAgent — zero network, zero DB (all LLM calls mocked).

import { jest } from '@jest/globals'

// ─── Mock ILLMClient ─────────────────────────────────────────────────────────

const mockChatFn = jest.fn<() => Promise<{ content: string; model: string; tokensIn: number; tokensOut: number; costUsd: number }>>()

const mockLlm = {
  chat: mockChatFn,
} as unknown as import('@/lib/llm/interface').ILLMClient

// ─── Imports ─────────────────────────────────────────────────────────────────

import {
  negotiateSprintContract,
  evaluate,
} from '@/lib/agents/eval/eval.agent'
import {
  getRubricForProfile,
  MARKETING_CONTENT_RUBRIC,
  APP_SCAFFOLDING_RUBRIC,
  LEGAL_COMPLIANCE_RUBRIC,
  DATA_REPORTING_RUBRIC,
  GENERIC_RUBRIC,
} from '@/lib/agents/eval/eval-rubrics'
import type { SprintContract, ScoredCriterion } from '@/lib/agents/eval/eval.types'
import type { WriterOutput } from '@/lib/agents/writer'
import type { ReviewerOutput } from '@/lib/agents/reviewer'
import type { PlannerHandoff } from '@/lib/agents/planner'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePlannerHandoff(profile = 'marketing_content'): PlannerHandoff {
  return {
    handoff_version: '1.0',
    source_agent: 'PLANNER',
    target_agent: 'DAG_EXECUTOR',
    run_id: 'run-1',
    domain_profile: profile as import('@/lib/agents/classifier').ProfileId,
    task_summary: 'Write a blog post about AI tools',
    assumptions: [],
    dag: {
      nodes: [
        {
          node_id: 'n1',
          agent: 'WRITER',
          description: 'Write blog post',
          dependencies: [],
          llm_strategy: 'balanced',
          complexity: 'medium',
          timeout_minutes: 5,
          inputs: [],
          expected_output_type: 'markdown',
        },
        {
          node_id: 'n2',
          agent: 'REVIEWER',
          description: 'Review blog post',
          dependencies: ['n1'],
          llm_strategy: 'powerful',
          complexity: 'low',
          timeout_minutes: 3,
          inputs: ['output:n1'],
          expected_output_type: 'review',
        },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    },
    meta: {
      confidence: 90,
      confidence_rationale: 'clear task',
      estimated_total_tokens: 1000,
      estimated_cost_usd: 0.05,
      estimated_duration_minutes: 5,
      parallel_branches: [],
      human_gate_points: ['n2'],
    },
    requires_human_approval: false,
  }
}

function makeWriterOutput(run_id = 'run-1'): WriterOutput {
  return {
    handoff_version: '1.0',
    source_agent: 'WRITER',
    source_node_id: 'n1',
    target_agent: 'REVIEWER',
    run_id,
    output: {
      type: 'markdown',
      summary: 'Blog post about AI tools',
      content: '# AI tools\n\nBuy now!',
      confidence: 80,
      confidence_rationale: 'clear task',
    },
    assumptions_made: [],
    execution_meta: {
      llm_used: 'claude-haiku',
      tokens_input: 100,
      tokens_output: 200,
      duration_seconds: 2,
      retries: 0,
    },
    lateral_delegation_request: null,
  }
}

function makeReviewerOutput(run_id = 'run-1'): ReviewerOutput {
  return {
    handoff_version: '1.0',
    source_agent: 'REVIEWER',
    target: 'HUMAN_GATE',
    run_id,
    verdict: 'APPROVE',
    findings: [],
    overall_confidence: 90,
    overall_confidence_rationale: 'looks good',
    meta: {
      llm_used: 'claude-haiku',
      tokens_input: 200,
      tokens_output: 100,
      duration_seconds: 2,
    },
  }
}

function makeSprintContract(overrides: Partial<SprintContract> = {}): SprintContract {
  return {
    run_id: 'run-1',
    deliverables: ['Blog post as markdown'],
    success_criteria: MARKETING_CONTENT_RUBRIC,
    pass_threshold: 0.7,
    ...overrides,
  }
}

function makeLlmResult(content: string) {
  return {
    content,
    model: 'claude-haiku',
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0,
  }
}

// ─── getRubricForProfile ─────────────────────────────────────────────────────

describe('getRubricForProfile', () => {
  it('returns MARKETING_CONTENT_RUBRIC for marketing_content', () => {
    expect(getRubricForProfile('marketing_content')).toBe(MARKETING_CONTENT_RUBRIC)
  })

  it('returns APP_SCAFFOLDING_RUBRIC for app_scaffolding', () => {
    expect(getRubricForProfile('app_scaffolding')).toBe(APP_SCAFFOLDING_RUBRIC)
  })

  it('returns LEGAL_COMPLIANCE_RUBRIC for legal_compliance', () => {
    expect(getRubricForProfile('legal_compliance')).toBe(LEGAL_COMPLIANCE_RUBRIC)
  })

  it('returns DATA_REPORTING_RUBRIC for data_reporting', () => {
    expect(getRubricForProfile('data_reporting')).toBe(DATA_REPORTING_RUBRIC)
  })

  it('returns GENERIC_RUBRIC for unknown profile', () => {
    expect(getRubricForProfile('unknown_profile')).toBe(GENERIC_RUBRIC)
  })

  it('returns GENERIC_RUBRIC for generic profile', () => {
    expect(getRubricForProfile('generic')).toBe(GENERIC_RUBRIC)
  })
})

// ─── Rubric integrity ────────────────────────────────────────────────────────

describe('rubric weight integrity', () => {
  const rubrics = [
    ['marketing_content', MARKETING_CONTENT_RUBRIC],
    ['app_scaffolding', APP_SCAFFOLDING_RUBRIC],
    ['legal_compliance', LEGAL_COMPLIANCE_RUBRIC],
    ['data_reporting', DATA_REPORTING_RUBRIC],
    ['generic', GENERIC_RUBRIC],
  ] as const

  rubrics.forEach(([name, rubric]) => {
    it(`${name}: weights sum to 1.0`, () => {
      const total = rubric.reduce((s, c) => s + c.weight, 0)
      expect(Math.abs(total - 1.0)).toBeLessThan(0.001)
    })

    it(`${name}: all weights > 0`, () => {
      expect(rubric.every(c => c.weight > 0)).toBe(true)
    })

    it(`${name}: all scores between 0 and 1 conceptually`, () => {
      expect(rubric.every(c => c.weight <= 1)).toBe(true)
    })
  })

  it('app_scaffolding has 3 hard_fail criteria (compiles, tests_pass, smoke)', () => {
    const hardFails = APP_SCAFFOLDING_RUBRIC.filter(c => c.hard_fail)
    expect(hardFails.length).toBe(3)
    expect(hardFails.map(c => c.id)).toContain('compiles')
    expect(hardFails.map(c => c.id)).toContain('tests_pass')
    expect(hardFails.map(c => c.id)).toContain('smoke')
  })

  it('legal_compliance disclaimer is hard_fail', () => {
    const disclaimer = LEGAL_COMPLIANCE_RUBRIC.find(c => c.id === 'disclaimer')
    expect(disclaimer?.hard_fail).toBe(true)
  })

  it('marketing_content cta_present is hard_fail', () => {
    const cta = MARKETING_CONTENT_RUBRIC.find(c => c.id === 'cta_present')
    expect(cta?.hard_fail).toBe(true)
  })
})

// ─── negotiateSprintContract ─────────────────────────────────────────────────

describe('negotiateSprintContract', () => {
  beforeEach(() => jest.resetAllMocks())

  it('returns contract from LLM response', async () => {
    const contractJson = {
      deliverables: ['Blog post'],
      success_criteria: [
        { id: 'cta_present', name: 'CTA', weight: 0.5, hard_fail: true },
        { id: 'clarity', name: 'Clarity', weight: 0.5, hard_fail: false },
      ],
      pass_threshold: 0.75,
    }
    mockChatFn.mockResolvedValue(makeLlmResult(JSON.stringify(contractJson)))

    const handoff = makePlannerHandoff()
    const contract = await negotiateSprintContract(handoff, mockLlm)

    expect(contract.run_id).toBe('run-1')
    expect(contract.pass_threshold).toBe(0.75)
    expect(contract.success_criteria).toHaveLength(2)
  })

  it('normalizes weights when they do not sum to 1', async () => {
    const contractJson = {
      deliverables: [],
      success_criteria: [
        { id: 'a', name: 'A', weight: 2, hard_fail: false },
        { id: 'b', name: 'B', weight: 2, hard_fail: false },
      ],
      pass_threshold: 0.7,
    }
    mockChatFn.mockResolvedValue(makeLlmResult(JSON.stringify(contractJson)))

    const contract = await negotiateSprintContract(makePlannerHandoff(), mockLlm)
    const total = contract.success_criteria.reduce((s, c) => s + c.weight, 0)
    expect(Math.abs(total - 1.0)).toBeLessThan(0.001)
  })

  it('falls back to base rubric when LLM returns malformed JSON', async () => {
    mockChatFn.mockResolvedValue(makeLlmResult('not json'))
    const contract = await negotiateSprintContract(makePlannerHandoff('marketing_content'), mockLlm)
    // Should fall back without throwing
    expect(contract.success_criteria).toBeDefined()
    expect(contract.success_criteria.length).toBeGreaterThan(0)
    expect(contract.pass_threshold).toBe(0.7)
  })

  it('clamps pass_threshold to [0, 1]', async () => {
    mockChatFn.mockResolvedValue(makeLlmResult(JSON.stringify({
      deliverables: [],
      success_criteria: MARKETING_CONTENT_RUBRIC,
      pass_threshold: 1.5,  // too high
    })))
    const contract = await negotiateSprintContract(makePlannerHandoff(), mockLlm)
    expect(contract.pass_threshold).toBeLessThanOrEqual(1.0)
  })
})

// ─── evaluate ────────────────────────────────────────────────────────────────

describe('evaluate', () => {
  beforeEach(() => jest.resetAllMocks())

  function makeEvalResponse(criteriaScores: Record<string, number>, feedback: string | null = null): string {
    const criteria: ScoredCriterion[] = MARKETING_CONTENT_RUBRIC.map(c => ({
      ...c,
      score: criteriaScores[c.id] ?? 0.8,
      rationale: 'looks good',
    }))
    return JSON.stringify({ criteria, feedback })
  }

  it('returns PASS when score above threshold and no hard fail', async () => {
    // All criteria score 0.9 → passes
    mockChatFn.mockResolvedValue(makeLlmResult(makeEvalResponse({
      cta_present: 0.9, tone: 0.9, clarity: 0.9, length: 0.9, structure: 0.9, originality: 0.9,
    })))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      1,
      mockLlm,
    )

    expect(result.verdict).toBe('PASS')
    expect(result.passed).toBe(true)
    expect(result.overall_score).toBeGreaterThanOrEqual(0.7)
    expect(result.feedback).toBeNull()
  })

  it('returns RETRY when score below threshold on attempt 1', async () => {
    // Low scores → fails
    mockChatFn.mockResolvedValue(makeLlmResult(makeEvalResponse({
      cta_present: 0.6, tone: 0.5, clarity: 0.5, length: 0.5, structure: 0.5, originality: 0.6,
    }, 'Add a stronger call to action')))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      1,
      mockLlm,
    )

    expect(result.verdict).toBe('RETRY')
    expect(result.passed).toBe(false)
    expect(result.feedback).toBe('Add a stronger call to action')
  })

  it('returns RETRY immediately when hard_fail criterion scores < 0.5', async () => {
    // cta_present is hard_fail and scores 0.3
    mockChatFn.mockResolvedValue(makeLlmResult(makeEvalResponse({
      cta_present: 0.3, tone: 0.9, clarity: 0.9, length: 0.9, structure: 0.9, originality: 0.9,
    }, 'Add a call to action')))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      1,
      mockLlm,
    )

    expect(result.verdict).toBe('RETRY')
    expect(result.hard_fail_ids).toContain('cta_present')
    expect(result.passed).toBe(false)
  })

  it('returns ESCALATE_HUMAN on attempt 3 regardless of score', async () => {
    // Fail scores but on attempt 3
    mockChatFn.mockResolvedValue(makeLlmResult(makeEvalResponse({
      cta_present: 0.3, tone: 0.3, clarity: 0.3, length: 0.3, structure: 0.3, originality: 0.3,
    }, 'Still needs a CTA')))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      3,  // last attempt
      mockLlm,
    )

    expect(result.verdict).toBe('ESCALATE_HUMAN')
    expect(result.passed).toBe(true)  // forced pass on last attempt
    expect(result.attempt).toBe(3)
  })

  it('handles malformed LLM response with emergency pass', async () => {
    mockChatFn.mockResolvedValue(makeLlmResult('invalid json {{'))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      1,
      mockLlm,
    )

    expect(result.verdict).toBe('ESCALATE_HUMAN')
    expect(result.passed).toBe(true)   // emergency pass
    expect(result.feedback).toContain('malformed')
  })

  it('clamps attempt to 1–3 range', async () => {
    mockChatFn.mockResolvedValue(makeLlmResult(makeEvalResponse({
      cta_present: 0.9, tone: 0.9, clarity: 0.9, length: 0.9, structure: 0.9, originality: 0.9,
    })))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      99,  // over max
      mockLlm,
    )

    expect(result.attempt).toBe(3)
  })

  it('overall_score is a weighted average (not a simple average)', async () => {
    // cta_present weight=0.25, score=0.8; all others score=0.0
    mockChatFn.mockResolvedValue(makeLlmResult(makeEvalResponse({
      cta_present: 1.0, tone: 0.0, clarity: 0.0, length: 0.0, structure: 0.0, originality: 0.0,
    })))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      1,
      mockLlm,
    )

    // Expected: cta_present contrib only = 1.0 * 0.25 = 0.25
    // (weights normalized to 1.0 so overall = sum(score * weight))
    expect(result.overall_score).toBeCloseTo(0.25, 1)
  })

  it('feedback is null when verdict is PASS', async () => {
    mockChatFn.mockResolvedValue(makeLlmResult(makeEvalResponse({
      cta_present: 0.9, tone: 0.9, clarity: 0.9, length: 0.9, structure: 0.9, originality: 0.9,
    }, 'some feedback')))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      1,
      mockLlm,
    )

    expect(result.verdict).toBe('PASS')
    expect(result.feedback).toBeNull()  // cleared on pass
  })

  it('missing criteria in LLM response default to score=0', async () => {
    // LLM only returns 2 criteria instead of 6
    const partialCriteria = [
      { id: 'cta_present', name: 'CTA', weight: 0.25, hard_fail: true, score: 0.9, rationale: 'good' },
    ]
    mockChatFn.mockResolvedValue(makeLlmResult(JSON.stringify({
      criteria: partialCriteria,
      feedback: null,
    })))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract(),
      'marketing_content',
      'run-1',
      1,
      mockLlm,
    )

    // All 6 criteria should be present
    expect(result.criteria).toHaveLength(MARKETING_CONTENT_RUBRIC.length)
    // Missing ones should have score=0
    const missing = result.criteria.find(c => c.id === 'tone')
    expect(missing?.score).toBe(0)
  })

  it('app_scaffolding hard_fail ids include compiles when score < 0.5', async () => {
    const scaffoldCriteria = APP_SCAFFOLDING_RUBRIC.reduce((acc, c) => {
      acc[c.id] = c.id === 'compiles' ? 0.3 : 0.9
      return acc
    }, {} as Record<string, number>)
    const criteria: ScoredCriterion[] = APP_SCAFFOLDING_RUBRIC.map(c => ({
      ...c,
      score: scaffoldCriteria[c.id] ?? 0.9,
      rationale: 'test',
    }))
    mockChatFn.mockResolvedValue(makeLlmResult(JSON.stringify({ criteria, feedback: 'Fix compile errors' })))

    const result = await evaluate(
      [makeWriterOutput()],
      makeReviewerOutput(),
      makeSprintContract({ success_criteria: APP_SCAFFOLDING_RUBRIC }),
      'app_scaffolding',
      'run-1',
      1,
      mockLlm,
    )

    expect(result.hard_fail_ids).toContain('compiles')
    expect(result.verdict).toBe('RETRY')
  })
})
