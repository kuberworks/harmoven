// lib/self-improvement/types.ts
// Shared types for the self-improvement module (Amendment 92).
// Instance-health analysis — Docker-only, no data sent externally.

// ─── Suggestion ───────────────────────────────────────────────────────────────

export type SuggestionType =
  | 'LLM_PROFILE_ERROR_RATE'
  | 'LLM_PROFILE_LOW_SCORE'
  | 'RETRY_STORM'
  | 'REVIEWER_REJECTION_RATE'
  | 'BUDGET_OVERSHOOT'
  | 'GATE_FREQUENCY'
  | 'GATE_ABANDONMENT'

export type SuggestionSeverity = 'critical' | 'warning' | 'info'

/** Structured metrics payload attached to each suggestion — no user content, no DCP. */
export interface SuggestionEvidence {
  window_days:  number                    // analysis window used
  sample_count: number                    // number of nodes/runs/evals analysed
  metric_value: number                    // the measured value (e.g. 0.31 for 31%)
  metric_label: string                    // human-readable: "31% error rate"
  threshold:    number                    // configured threshold that was exceeded
  extras?:      Record<string, unknown>   // type-specific aggregated details
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** orchestrator.yaml → self_improvement section */
export interface SelfImprovementConfig {
  enabled:                boolean  // default: true
  analysis_interval_days: number   // default: 7 (weekly cron)
  lookback_days:          number   // default: 30
  min_sample_size:        number   // default: 10 (suppress alerts below this count)
  // Alert thresholds — all tunable in orchestrator.yaml
  threshold_error_rate:        number  // default: 0.25 (25 % node error rate)
  threshold_low_score:         number  // default: 2.5 (out of 5)
  threshold_retry_avg:         number  // default: 1.5 (avg retries per node)
  threshold_rejection_rate:    number  // default: 0.40 (40 % reviewer rejections)
  threshold_budget_overshoot:  number  // default: 0.50 (50 % of budgeted runs overshoot)
  threshold_gate_frequency:    number  // default: 0.30 (30 % of runs trigger gate)
}

export const DEFAULT_SELF_IMPROVEMENT_CONFIG: SelfImprovementConfig = {
  enabled:                     true,
  analysis_interval_days:      7,
  lookback_days:               30,
  min_sample_size:             10,
  threshold_error_rate:        0.25,
  threshold_low_score:         2.5,
  threshold_retry_avg:         1.5,
  threshold_rejection_rate:    0.40,
  threshold_budget_overshoot:  0.50,
  threshold_gate_frequency:    0.30,
}

// ─── Metrics (internal — emitted by analyzer, consumed by suggestions engine) ─

export interface ProfileNodeStat {
  llm_profile_id: string
  agent_type:     string
  total:          number
  errors:         number
  retries_sum:    number
  avg_retries:    number
  error_rate:     number
}

export interface ProfileEvalStat {
  llm_used:       string
  total_evals:    number
  avg_score:      number
  rejection_rate: number
}

export interface ProjectBudgetStat {
  project_id:       string
  runs_with_budget: number
  runs_overshoot:   number
  overshoot_rate:   number
}

export interface GateFrequencyStat {
  reason: string
  count:  number
  rate:   number  // gates_with_reason / total_completed_runs
}

export interface InstanceMetrics {
  profileNodeStats:    ProfileNodeStat[]
  profileEvalStats:    ProfileEvalStat[]
  projectBudgetStats:  ProjectBudgetStat[]
  gateFrequencyStats:  GateFrequencyStat[]
  gateAbandonedCount:  number
  from: Date
  to:   Date
}

// ─── Input for upsert (emitted by suggestions engine) ────────────────────────

export interface ImprovementSuggestionInput {
  type:        SuggestionType
  severity:    SuggestionSeverity
  title:       string
  body:        string
  evidence:    SuggestionEvidence
  target_id?:  string | null
  target_type?: string | null
  cycle_key:   string   // deterministic, used as upsert key
  expires_at:  Date
}
