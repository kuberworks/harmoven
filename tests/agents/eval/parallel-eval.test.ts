// tests/agents/eval/parallel-eval.test.ts
// Unit tests for parallelEval() — zero network, zero DB.
// evaluate() is mocked so we avoid real LLM calls and withRetry delays.

import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// ─── Mock evaluate so parallel-eval can be tested without LLM/withRetry ──────

jest.mock('@/lib/agents/eval/eval.agent', () => ({
  evaluate: jest.fn(),
}))

import { evaluate } from '@/lib/agents/eval/eval.agent'
import { parallelEval } from '@/lib/agents/eval/parallel-eval'
import type { EvalAgentOutput, SprintContract, ScoredCriterion } from '@/lib/agents/eval/eval.types'
import type { ILLMClient } from '@/lib/llm/interface'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MINI_CRITERIA = [
  { id: 'clarity',  name: 'Clarity',  weight: 0.5, hard_fail: false },
  { id: 'accuracy', name: 'Accuracy', weight: 0.5, hard_fail: false },
]

const CONTRACT: SprintContract = {
  run_id:           'run-test',
  deliverables:     ['deliverable'],
  success_criteria: MINI_CRITERIA,
  pass_threshold:   0.7,
}

// Stub ILLMClient — parallelEval passes it into evaluate() (now mocked), so any object works
const STUB_LLM = {} as unknown as ILLMClient

function makeEvalOutput(score: number, attempt = 1): EvalAgentOutput {
  const criteria: ScoredCriterion[] = MINI_CRITERIA.map(c => ({
    ...c,
    score,
    rationale: `score=${score}`,
  }))
  const passed  = score >= CONTRACT.pass_threshold
  const verdict = passed ? 'PASS' : 'RETRY'
  return {
    run_id:        'run-test',
    attempt,
    overall_score: score,
    passed,
    verdict,
    criteria,
    feedback:      passed ? null : 'Needs improvement',
    hard_fail_ids: [],
    meta: {
      llm_used:         `model-tier-${score}`,
      tokens_input:     100,
      tokens_output:    50,
      duration_seconds: 1,
    },
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parallelEval()', () => {
  const mockEvaluate = evaluate as jest.MockedFunction<typeof evaluate>

  beforeEach(() => mockEvaluate.mockReset())

  it('returns PASS when all models agree on a high score', async () => {
    // All three model tiers agree: score = 0.85 → std_dev = 0 → PASS
    mockEvaluate
      .mockResolvedValueOnce(makeEvalOutput(0.85))
      .mockResolvedValueOnce(makeEvalOutput(0.85))
      .mockResolvedValueOnce(makeEvalOutput(0.85))

    const result = await parallelEval(
      [], {} as never, CONTRACT, 'generic', 'run-test', 1, STUB_LLM,
    )

    expect(result.verdict).toBe('PASS')
    expect(result.passed).toBe(true)
    expect(result.overall_score).toBeCloseTo(0.85, 2)
    expect(result.meta.model_breakdown).toHaveLength(3)
    // All 3 model tiers must have been queried
    expect(mockEvaluate).toHaveBeenCalledTimes(3)
  })

  it('forces ESCALATE_HUMAN when models strongly disagree (std_dev > 0.2)', async () => {
    // fast=0.9, balanced=0.5, powerful=0.2 → std_dev ≈ 0.29 > 0.2
    mockEvaluate
      .mockResolvedValueOnce(makeEvalOutput(0.9))
      .mockResolvedValueOnce(makeEvalOutput(0.5))
      .mockResolvedValueOnce(makeEvalOutput(0.2))

    const result = await parallelEval(
      [], {} as never, CONTRACT, 'generic', 'run-test', 1, STUB_LLM,
    )

    expect(result.verdict).toBe('ESCALATE_HUMAN')
    expect(result.meta.model_breakdown).toHaveLength(3)
  })

  it('averages criteria scores across models for the consensus', async () => {
    // Model A: clarity=0.6 accuracy=0.8 → overall=0.7
    // Model B: clarity=0.8 accuracy=0.6 → overall=0.7
    // Consensus: clarity=0.7 accuracy=0.7 → overall=0.7
    const makeCustomOutput = (clarity: number, accuracy: number): EvalAgentOutput => ({
      ...makeEvalOutput(0.7),
      overall_score: 0.7,
      criteria: [
        { id: 'clarity',  name: 'Clarity',  weight: 0.5, hard_fail: false, score: clarity,  rationale: '' },
        { id: 'accuracy', name: 'Accuracy', weight: 0.5, hard_fail: false, score: accuracy, rationale: '' },
      ],
    })

    mockEvaluate
      .mockResolvedValueOnce(makeCustomOutput(0.6, 0.8))
      .mockResolvedValueOnce(makeCustomOutput(0.8, 0.6))
      .mockResolvedValueOnce(makeCustomOutput(0.7, 0.7))

    const result = await parallelEval(
      [], {} as never, CONTRACT, 'generic', 'run-test', 1, STUB_LLM,
      { models: ['fast', 'balanced'] },  // 2 models to keep it predictable
    )

    // Note: Only 2 mock values were consumed since we passed models: ['fast','balanced']
    const clarityScore  = result.criteria.find(c => c.id === 'clarity')?.score
    const accuracyScore = result.criteria.find(c => c.id === 'accuracy')?.score
    expect(clarityScore).toBeCloseTo(0.7, 1)   // (0.6+0.8)/2
    expect(accuracyScore).toBeCloseTo(0.7, 1)  // (0.8+0.6)/2
    expect(mockEvaluate).toHaveBeenCalledTimes(2)
  })

  it('succeeds with remaining models when some fail', async () => {
    // 2 of 3 calls succeed — parallelEval must not throw
    mockEvaluate
      .mockResolvedValueOnce(makeEvalOutput(0.85))
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce(makeEvalOutput(0.85))

    const result = await parallelEval(
      [], {} as never, CONTRACT, 'generic', 'run-test', 1, STUB_LLM,
    )

    expect(result.verdict).toBe('PASS')
    expect(result.meta.model_breakdown).toHaveLength(2)  // only the 2 that succeeded
  })

  it('returns ESCALATE_HUMAN emergency when every model fails', async () => {
    mockEvaluate.mockRejectedValue(new Error('All LLMs down'))

    const result = await parallelEval(
      [], {} as never, CONTRACT, 'generic', 'run-test', 1, STUB_LLM,
    )

    expect(result.verdict).toBe('ESCALATE_HUMAN')
    expect(result.passed).toBe(false)
    expect(result.overall_score).toBe(0)
    expect(result.meta.model_breakdown).toHaveLength(0)
  })

  it('respects custom escalate_std_dev_threshold option', async () => {
    // scores: 0.8, 0.75, 0.7 → std_dev ≈ 0.04 — normally PASS, but with threshold=0.01 should ESCALATE
    mockEvaluate
      .mockResolvedValueOnce(makeEvalOutput(0.8))
      .mockResolvedValueOnce(makeEvalOutput(0.75))
      .mockResolvedValueOnce(makeEvalOutput(0.7))

    const result = await parallelEval(
      [], {} as never, CONTRACT, 'generic', 'run-test', 1, STUB_LLM,
      { escalate_std_dev_threshold: 0.01 },
    )

    expect(result.verdict).toBe('ESCALATE_HUMAN')
  })

  it('picks feedback from the most critical (lowest-scoring) model', async () => {
    const high = makeEvalOutput(0.9)
    const low  = { ...makeEvalOutput(0.3), feedback: 'Specific improvement needed' }
    const mid  = makeEvalOutput(0.6)

    mockEvaluate
      .mockResolvedValueOnce(high)
      .mockResolvedValueOnce(low)
      .mockResolvedValueOnce(mid)

    const result = await parallelEval(
      [], {} as never, CONTRACT, 'generic', 'run-test', 1, STUB_LLM,
    )

    // Feedback comes from the model with the lowest overall_score (0.3 → 'low')
    expect(result.feedback).toBe('Specific improvement needed')
  })
})
