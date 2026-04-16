// lib/agents/eval/parallel-eval.ts
// Cross-model parallel validation — OMC-inspired pattern.
//
// Runs evaluate() in parallel across multiple LLM model tiers and synthesizes
// a consensus verdict via per-criterion score averaging.
//
// Escalation rule: if std_dev(overall_scores) > threshold (default 0.2),
// the synthesized verdict is forced to ESCALATE_HUMAN (models disagree).
// This catches cases where one model thinks the output is great while another
// thinks it's terrible — both extremes are suspicious.
//
// Usage:
//   import { parallelEval } from '@/lib/agents/eval/parallel-eval'
//   const result = await parallelEval(writerOutputs, reviewerOutput, contract,
//                                      profile, run_id, attempt, llmClient, {}, signal)

import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from '@/lib/llm/interface'
import type { WriterOutput }   from '@/lib/agents/writer'
import type { ReviewerOutput } from '@/lib/agents/reviewer'
import type { ProfileId }      from '@/lib/agents/classifier'
import { evaluate }            from './eval.agent'
import type {
  EvalAgentOutput,
  SprintContract,
  ScoredCriterion,
  EvalVerdict,
} from './eval.types'

// Default model tiers run in parallel
const DEFAULT_MODELS = ['fast', 'balanced', 'powerful'] as const

export interface ParallelEvalOpts {
  /** Model tiers to evaluate in parallel. Defaults to ['fast', 'balanced', 'powerful']. */
  models?: string[]
  /**
   * Standard-deviation threshold above which the synthesized verdict is forced
   * to ESCALATE_HUMAN (models disagree too much). Default 0.2.
   */
  escalate_std_dev_threshold?: number
}

export interface ModelBreakdownItem {
  model_tier:       string
  model_id:         string
  overall_score:    number
  verdict:          EvalVerdict
  duration_seconds: number
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Wraps an ILLMClient to override the `model` field in every ChatOptions.
 * This lets us call evaluate() — which internally hardcodes `model: 'powerful'` —
 * with any tier we choose, without modifying the existing evaluate() signature.
 */
function withModelTier(base: ILLMClient, tier: string): ILLMClient {
  return {
    chat: (messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> =>
      base.chat(messages, { ...options, model: tier }),
    stream: (
      messages: ChatMessage[],
      options:  ChatOptions,
      onChunk:  (chunk: string) => void,
    ): Promise<ChatResult> =>
      base.stream(messages, { ...options, model: tier }, onChunk),
  }
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const mean     = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function buildEmergencyEscalation(
  run_id:   string,
  attempt:  number,
  contract: SprintContract,
  startMs:  number,
): EvalAgentOutput {
  return {
    run_id,
    attempt,
    overall_score: 0,
    passed:        attempt >= 3,
    verdict:       'ESCALATE_HUMAN',
    criteria:      contract.success_criteria.map(c => ({
      ...c,
      score:     0,
      rationale: 'All parallel model evaluations failed — escalating to human review',
    })),
    feedback:      'All parallel model evaluations failed. Human review required.',
    hard_fail_ids: [],
    meta: {
      llm_used:         'none',
      tokens_input:     0,
      tokens_output:    0,
      duration_seconds: Math.round((Date.now() - startMs) / 1000),
      model_breakdown:  [],
    },
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Runs evaluate() in parallel across multiple model tiers and synthesizes a
 * consensus EvalAgentOutput.
 *
 * Synthesis rules:
 * - criterion.score = arithmetic mean of all model scores for that criterion
 * - verdict is forced to ESCALATE_HUMAN if std_dev(overall_scores) > threshold
 *   (signals model disagreement — needs human arbitration)
 * - feedback is taken from the most critical model (lowest overall_score)
 * - meta.model_breakdown captures raw per-model results for debugging
 *
 * Failed model calls are silently dropped (Promise.allSettled); if ALL fail,
 * an ESCALATE_HUMAN emergency result is returned.
 */
export async function parallelEval(
  writerOutputs:  WriterOutput[],
  reviewerOutput: ReviewerOutput,
  contract:       SprintContract,
  profile:        ProfileId,
  run_id:         string,
  attempt:        number,
  llm:            ILLMClient,
  opts:           ParallelEvalOpts = {},
  signal?:        AbortSignal,
): Promise<EvalAgentOutput> {
  const tiers     = opts.models ?? [...DEFAULT_MODELS]
  const threshold = opts.escalate_std_dev_threshold ?? 0.2
  const startMs   = Date.now()

  // Run all model evaluations in parallel — settled so one failure doesn't block others
  const settled = await Promise.allSettled(
    tiers.map(tier =>
      evaluate(
        writerOutputs,
        reviewerOutput,
        contract,
        profile,
        run_id,
        attempt,
        withModelTier(llm, tier),
        signal,
      ).then(result => ({ tier, result })),
    ),
  )

  const successes = settled
    .filter(
      (s): s is PromiseFulfilledResult<{ tier: string; result: EvalAgentOutput }> =>
        s.status === 'fulfilled',
    )
    .map(s => s.value)

  if (successes.length === 0) {
    return buildEmergencyEscalation(run_id, attempt, contract, startMs)
  }

  // Build the per-model breakdown for debugging / observability
  const breakdown: ModelBreakdownItem[] = successes.map(({ tier, result }) => ({
    model_tier:       tier,
    model_id:         result.meta.llm_used,
    overall_score:    result.overall_score,
    verdict:          result.verdict,
    duration_seconds: result.meta.duration_seconds,
  }))

  // Synthesize per-criterion scores (arithmetic mean across models)
  const mergedCriteria: ScoredCriterion[] = contract.success_criteria.map(base => {
    const scores = successes
      .flatMap(({ result }) => result.criteria.filter(c => c.id === base.id))
      .map(c => c.score)

    const meanScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0.5  // neutral fallback if no model returned this criterion

    const rationales = successes
      .flatMap(({ result }) => result.criteria.filter(c => c.id === base.id))
      .map(c => c.rationale)
      .filter(Boolean)

    return {
      ...base,
      score:     meanScore,
      rationale: rationales.join(' | '),
    } satisfies ScoredCriterion
  })

  // Consensus verdict
  const overallScore = mergedCriteria.reduce((sum, c) => sum + c.score * c.weight, 0)
  const hardFailIds  = mergedCriteria.filter(c => c.hard_fail && c.score < 0.5).map(c => c.id)
  const passed       = hardFailIds.length === 0 && overallScore >= contract.pass_threshold
  const finalPassed  = attempt >= 3 ? true : passed

  // Disagreement check — pushes to human review when models can't agree
  const disagreement = stdDev(successes.map(s => s.result.overall_score))

  let verdict: EvalVerdict
  if (disagreement > threshold) {
    verdict = 'ESCALATE_HUMAN'
  } else if (!passed && attempt >= 3) {
    verdict = 'ESCALATE_HUMAN'
  } else if (finalPassed) {
    verdict = 'PASS'
  } else {
    verdict = 'RETRY'
  }

  // Collect feedback from the most critical model (lowest overall_score)
  const mostCritical = successes.reduce((a, b) =>
    a.result.overall_score < b.result.overall_score ? a : b,
  )
  const feedback = finalPassed ? null : mostCritical.result.feedback

  const totalTokensIn  = successes.reduce((a, b) => a + b.result.meta.tokens_input,  0)
  const totalTokensOut = successes.reduce((a, b) => a + b.result.meta.tokens_output, 0)

  return {
    run_id,
    attempt,
    overall_score: overallScore,
    passed:        finalPassed,
    verdict,
    criteria:      mergedCriteria,
    feedback,
    hard_fail_ids: hardFailIds,
    meta: {
      llm_used:         successes.map(s => s.result.meta.llm_used).join('+'),
      tokens_input:     totalTokensIn,
      tokens_output:    totalTokensOut,
      duration_seconds: Math.round((Date.now() - startMs) / 1000),
      model_breakdown:  breakdown,
    },
  }
}
