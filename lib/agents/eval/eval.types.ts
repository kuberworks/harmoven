// lib/agents/eval/eval.types.ts
// Amendment 89 — EvalAgent types

// ─── Sprint contract (negotiated before Writers start) ───────────────────────

export interface EvalCriterion {
  id:        string
  name:      string
  weight:    number    // 0.0–1.0, sum across criteria should equal 1.0
  hard_fail: boolean   // score < 0.5 on this criterion → immediate retry
}

export interface SprintContract {
  run_id:           string
  deliverables:     string[]          // what will be produced
  success_criteria: EvalCriterion[]   // how it will be graded
  pass_threshold:   number            // 0.0–1.0, default 0.7
}

// ─── Eval output ─────────────────────────────────────────────────────────────

export interface ScoredCriterion extends EvalCriterion {
  score:    number    // 0.0–1.0
  rationale: string
}

export type EvalVerdict = 'PASS' | 'RETRY' | 'ESCALATE_HUMAN'

export interface EvalAgentOutput {
  run_id:        string
  attempt:       number            // 1, 2, or 3
  overall_score: number            // weighted average
  passed:        boolean           // overall_score >= pass_threshold
  verdict:       EvalVerdict
  criteria:      ScoredCriterion[]
  feedback:      string | null     // passed to Writer on retry
  hard_fail_ids: string[]          // criterion ids that triggered hard fail
  meta: {
    llm_used:         string
    tokens_input:     number
    tokens_output:    number
    duration_seconds: number
  }
}

// ─── DB persisted shape (matches Prisma EvalResult) ──────────────────────────

export interface EvalResultRecord {
  id:            string
  run_id:        string
  node_id:       string
  attempt:       number
  overall_score: number
  passed:        boolean
  criteria:      ScoredCriterion[]  // stored as JSON
  feedback:      string | null
  computed_at:   Date
}
