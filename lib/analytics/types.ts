// lib/analytics/types.ts
// Shared types for the analytics module (Amendment 85).
// These types are used by compute.ts, export.ts, board-kpis.ts, and the API routes.

// ─── Query ───────────────────────────────────────────────────────────────────

export interface AnalyticsQuery {
  from: Date
  to: Date
  project_id?: string | null  // null = all accessible projects
  granularity?: 'day' | 'week' | 'month'
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface AnalyticsSummary {
  // Volume
  runs_total: number
  runs_completed: number
  runs_failed: number
  completion_rate_pct: number

  // Users
  users_active: number
  users_retained: number
  retention_rate_pct: number

  // Cost
  cost_total_usd: number
  cost_per_run_usd: number
  cost_per_active_user_usd: number

  // Quality
  approval_direct_rate_pct: number
  avg_critical_findings: number
  avg_user_rating: number | null

  // Value
  estimated_hours_saved_total: number | null
  estimated_value_usd: number | null  // hours × hourly_rate config
  roi_multiplier: number | null       // value / cost
}

// ─── Timeseries ──────────────────────────────────────────────────────────────

export interface AnalyticsDataPoint {
  date: string
  runs_completed: number
  cost_usd: number
  users_active: number
  avg_rating: number | null
}

// ─── Breakdowns ──────────────────────────────────────────────────────────────

export interface ProfileBreakdown {
  profile: string
  runs: number
  cost_usd: number
  avg_duration_s: number
  completion_rate: number
  avg_rating: number | null
}

export interface UserBreakdown {
  user_id: string
  display_name: string  // anonymized as "User A", "User B" when anonymize_exports=true
  runs_authored: number
  avg_contribution_pct: number
  avg_rating: number | null
  hours_saved: number | null
}

// ─── Board KPIs ──────────────────────────────────────────────────────────────

export interface BoardKPI {
  id: string
  label: string
  value: string
  delta?: string         // "+34%" or "-5pts" vs previous period
  trend: 'up' | 'down' | 'neutral'
  good_when: 'up' | 'down'
}

// ─── Full response ────────────────────────────────────────────────────────────

export interface AnalyticsResponse {
  period: { from: string; to: string }
  granularity: string
  summary: AnalyticsSummary
  timeseries: AnalyticsDataPoint[]
  by_profile: ProfileBreakdown[]
  by_user: UserBreakdown[]
  top_kpis: BoardKPI[]
}

// ─── User period stats (cross-run aggregation) ────────────────────────────────

export type WorkUnitType =
  | 'task_authoring'
  | 'gate_decision'
  | 'context_injection'
  | 'node_authoring'
  | 'other'

export interface UserPeriodStats {
  user_id: string
  period: { from: Date; to: Date }

  // Volume
  runs_authored: number
  runs_participated: number
  projects_active: number

  // Contributions
  total_weight: number
  avg_contribution_pct: number
  contribution_by_type: Record<WorkUnitType, { count: number; weight: number }>

  // Quality signals
  gates_decided: number
  gates_approved_direct: number
  gates_modified: number
  critical_findings_fixed: number
  critical_findings_ignored: number
  context_injections: number

  // Output quality
  runs_rated: number
  avg_rating: number | null

  // Time & value
  estimated_hours_saved_total: number | null
  runs_with_hours_data: number
}
