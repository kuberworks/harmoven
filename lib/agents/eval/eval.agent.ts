// lib/agents/eval/eval.agent.ts
// Amendment 89 — EvalAgent: sprint contract negotiation + quality feedback loop.
//
// Pipeline position:
//   Writer(s) → Standard Reviewer → EvalAgent → score ≥ threshold?
//                                                    ↓           ↓
//                                                 [Gate]    feedback → retry
//                                              Completed    (max 2 retries)
//
// Key behaviours:
// 1. negotiateSprintContract() — called by Planner BEFORE Writers start.
// 2. evaluate() — called AFTER Standard Reviewer approves.
// 3. Hard-fail criterion (score < 0.5) → immediate retry without waiting
//    for overall_score threshold check.
// 4. Max 2 retries = 3 total attempts.  attempt 3 always passes to Gate.
// 5. EvalResult persisted to DB at every attempt.

import type { ILLMClient } from '@/lib/llm/interface'
import type { WriterOutput } from '@/lib/agents/writer'
import type { ReviewerOutput } from '@/lib/agents/reviewer'
import type { ProfileId } from '@/lib/agents/classifier'
import type { PlannerHandoff } from '@/lib/agents/planner'
import { withRetry } from '@/lib/utils/retry'
import { getRubricForProfile } from './eval-rubrics'
import type {
  SprintContract,
  EvalCriterion,
  ScoredCriterion,
  EvalAgentOutput,
  EvalVerdict,
} from './eval.types'

export { SprintContract, EvalCriterion, ScoredCriterion, EvalAgentOutput, EvalVerdict }

// ─── Sprint contract negotiation ─────────────────────────────────────────────

function buildContractNegotiationPrompt(
  planner: PlannerHandoff,
  criteria: EvalCriterion[],
): string {
  return `You are the Harmoven EvalAgent. Based on the Planner's task breakdown and the
domain rubric, confirm or refine the success criteria for this sprint.

Planner summary: ${planner.task_summary}
Domain profile:  ${planner.domain_profile}

Deliverables from Planner nodes:
${planner.dag.nodes
  .filter(n => n.agent === 'WRITER')
  .map(n => `- [${n.node_id}] ${n.description} → ${n.expected_output_type}`)
  .join('\n')}

Proposed criteria (adjust weights and hard_fail if needed — weights must sum to 1.0):
${JSON.stringify(criteria, null, 2)}

Respond ONLY with valid JSON:
{
  "deliverables": ["<string>", ...],
  "success_criteria": [
    { "id": "string", "name": "string", "weight": number, "hard_fail": boolean }
  ],
  "pass_threshold": number
}

Rules:
- weights must sum to exactly 1.0
- pass_threshold: 0.0–1.0, default 0.7 (raise for critical domains)
- hard_fail: true only for criteria that make the output useless if failed
- Max 8 criteria
- No markdown, no prose — JSON only`
}

/**
 * Negotiate success criteria with the Planner before Writers start.
 * Returns a ready-to-use SprintContract.
 */
export async function negotiateSprintContract(
  planner: PlannerHandoff,
  llm: ILLMClient,
  signal?: AbortSignal,
): Promise<SprintContract> {
  const baseCriteria = getRubricForProfile(planner.domain_profile)

  const raw = await withRetry(
    () => llm.chat(
      [
        {
          role: 'system',
          content: buildContractNegotiationPrompt(planner, baseCriteria),
        },
        {
          role: 'user',
          content: JSON.stringify({
            run_id: planner.run_id,
            task_summary: planner.task_summary,
            domain_profile: planner.domain_profile,
          }),
        },
      ],
      { model: 'balanced', signal },
    ),
    { signal },
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.content)
  } catch {
    // Fallback to base rubric if LLM response is malformed
    return buildFallbackContract(planner.run_id, planner.domain_profile)
  }

  const p = parsed as Record<string, unknown>
  const criteria = (p['success_criteria'] as EvalCriterion[] | undefined) ?? baseCriteria
  const passThreshold = typeof p['pass_threshold'] === 'number'
    ? Math.min(1, Math.max(0, p['pass_threshold'] as number))
    : 0.7

  // Ensure weights sum to 1.0 — normalise if needed
  const normalized = normalizeCriteriaWeights(criteria)

  return {
    run_id:           planner.run_id,
    deliverables:     (p['deliverables'] as string[] | undefined) ?? [],
    success_criteria: normalized,
    pass_threshold:   passThreshold,
  }
}

function buildFallbackContract(run_id: string, profileId: ProfileId): SprintContract {
  return {
    run_id,
    deliverables:     [],
    success_criteria: normalizeCriteriaWeights(getRubricForProfile(profileId)),
    pass_threshold:   0.7,
  }
}

function normalizeCriteriaWeights(criteria: EvalCriterion[]): EvalCriterion[] {
  const total = criteria.reduce((s, c) => s + c.weight, 0)
  if (total === 0 || Math.abs(total - 1.0) < 0.001) return criteria
  return criteria.map(c => ({ ...c, weight: c.weight / total }))
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

function buildEvalPrompt(
  writerOutputs: WriterOutput[],
  reviewerOutput: ReviewerOutput,
  contract: SprintContract,
  profile: ProfileId,
  attempt: number,
): string {
  return `You are the Harmoven EvalAgent scoring quality output.

Domain profile: ${profile}
Attempt:        ${attempt} of 3

Sprint contract success criteria:
${JSON.stringify(contract.success_criteria, null, 2)}

Pass threshold: ${contract.pass_threshold}

Standard Reviewer result:
- Verdict: ${reviewerOutput.verdict}
- Confidence: ${reviewerOutput.overall_confidence}
- Reviewerfindings count: ${reviewerOutput.findings.length}

Writer outputs summary:
${writerOutputs.map(w => `- [${w.source_node_id}] ${w.output.summary} (confidence: ${w.output.confidence})`).join('\n')}

Score EACH criterion from 0.0 (completely failed) to 1.0 (perfect).
hard_fail criteria with score < 0.5 must trigger a retry.

Respond ONLY with valid JSON:
{
  "criteria": [
    {
      "id": "string",
      "name": "string",
      "weight": number,
      "hard_fail": boolean,
      "score": number,
      "rationale": "string"
    }
  ],
  "feedback": "string or null — actionable improvement guidance for the Writer"
}

Rules:
- Include ALL criteria from the sprint contract
- feedback must be actionable (specific improvements) or null if passed
- No markdown, no prose — JSON only`
}

const MAX_ATTEMPTS = 3

/**
 * Evaluate writer + reviewer output against the sprint contract.
 *
 * Returns EvalAgentOutput. The caller is responsible for:
 * - Persisting the result to DB (EvalResult model)
 * - Deciding whether to retry Writers or proceed to Human Gate
 *
 * Retry logic for the caller:
 *   if (!output.passed && attempt < MAX_ATTEMPTS) → re-run Writers with output.feedback
 *   else → proceed to Human Gate regardless of score
 */
export async function evaluate(
  writerOutputs: WriterOutput[],
  reviewerOutput: ReviewerOutput,
  contract: SprintContract,
  profile: ProfileId,
  run_id: string,
  attempt: number,
  llm: ILLMClient,
  signal?: AbortSignal,
): Promise<EvalAgentOutput> {
  const startMs = Date.now()
  const clampedAttempt = Math.min(Math.max(1, attempt), MAX_ATTEMPTS)

  const rawResult = await withRetry(
    () => llm.chat(
      [
        {
          role: 'system',
          content: buildEvalPrompt(writerOutputs, reviewerOutput, contract, profile, clampedAttempt),
        },
        {
          role: 'user',
          content: JSON.stringify({ run_id }),
        },
      ],
      { model: 'powerful', signal },
    ),
    { signal },
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(rawResult.content)
  } catch {
    // Malformed response → emergency pass to avoid infinite loop
    return buildEmergencyPass(run_id, clampedAttempt, contract, rawResult.model, rawResult.tokensIn, rawResult.tokensOut, startMs)
  }

  const p = parsed as Record<string, unknown>
  const scored = (p['criteria'] as ScoredCriterion[] | undefined) ?? []
  const feedback = typeof p['feedback'] === 'string' ? p['feedback'] : null

  // Merge spec criteria with scores (protect against LLM dropping criteria)
  const mergedCriteria = mergeScoredCriteria(contract.success_criteria, scored)

  // Compute weighted overall score
  const overallScore = computeWeightedScore(mergedCriteria)
  const hardFailIds  = mergedCriteria
    .filter(c => c.hard_fail && c.score < 0.5)
    .map(c => c.id)

  const passed = hardFailIds.length === 0 && overallScore >= contract.pass_threshold

  // On attempt 3 (last chance), always proceed to Human Gate — human decides
  const finalPassed = clampedAttempt >= MAX_ATTEMPTS ? true : passed

  let verdict: EvalVerdict
  if (!passed && clampedAttempt >= MAX_ATTEMPTS) {
    // Failed on last attempt — still goes to Human Gate but flagged for review
    verdict = 'ESCALATE_HUMAN'
  } else if (finalPassed) {
    verdict = 'PASS'
  } else {
    verdict = 'RETRY'
  }

  return {
    run_id,
    attempt:       clampedAttempt,
    overall_score: overallScore,
    passed:        finalPassed,
    verdict,
    criteria:      mergedCriteria,
    feedback:      finalPassed ? null : feedback,
    hard_fail_ids: hardFailIds,
    meta: {
      llm_used:         rawResult.model,
      tokens_input:     rawResult.tokensIn,
      tokens_output:    rawResult.tokensOut,
      duration_seconds: Math.round((Date.now() - startMs) / 1000),
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeScoredCriteria(
  contractCriteria: EvalCriterion[],
  scored: ScoredCriterion[],
): ScoredCriterion[] {
  const scoreMap = new Map(scored.map(s => [s.id, s]))

  return contractCriteria.map(c => {
    const existing = scoreMap.get(c.id)
    return {
      ...c,
      score:     existing ? Math.min(1, Math.max(0, existing.score)) : 0,
      rationale: existing?.rationale ?? 'Not evaluated',
    }
  })
}

function computeWeightedScore(criteria: ScoredCriterion[]): number {
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0)
  if (totalWeight === 0) return 0
  const weighted = criteria.reduce((s, c) => s + c.score * c.weight, 0)
  return Math.round((weighted / totalWeight) * 100) / 100
}

function buildEmergencyPass(
  run_id: string,
  attempt: number,
  contract: SprintContract,
  model: string,
  tokensIn: number,
  tokensOut: number,
  startMs: number,
): EvalAgentOutput {
  const fallbackCriteria: ScoredCriterion[] = contract.success_criteria.map(c => ({
    ...c,
    score:     0.5,
    rationale: 'Could not score — EvalAgent response was malformed',
  }))

  return {
    run_id,
    attempt,
    overall_score: 0.5,
    passed:        true,   // pass to avoid infinite loop
    verdict:       'ESCALATE_HUMAN',
    criteria:      fallbackCriteria,
    feedback:      'EvalAgent returned malformed output — human review required',
    hard_fail_ids: [],
    meta: {
      llm_used:         model,
      tokens_input:     tokensIn,
      tokens_output:    tokensOut,
      duration_seconds: Math.round((Date.now() - startMs) / 1000),
    },
  }
}
