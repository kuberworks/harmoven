// types/api.ts
// Hand-crafted TypeScript types for the Harmoven public API v1.
// Source of truth: openapi/v1.yaml — keep in sync.
//
// Auto-generation is available via:
//   npm run generate:types
// which runs openapi-typescript against openapi/v1.yaml and overwrites this file.
// When auto-generation is not available, maintain types here manually.

// ─── Primitive enums ─────────────────────────────────────────────────────────

export type RunStatus  = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SUSPENDED' | 'PAUSED'
export type NodeStatus = 'PENDING' | 'RUNNING' | 'BLOCKED' | 'FAILED' | 'ESCALATED' | 'SKIPPED' | 'COMPLETED' | 'DEADLOCKED' | 'INTERRUPTED'
export type LlmProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'cometapi'
export type LlmTier    = 'fast' | 'balanced' | 'powerful'

// ─── Core domain types ───────────────────────────────────────────────────────

export interface ApiError {
  error: string
}

export interface DagNode {
  id:         string
  agent_type: string
  config?:    Record<string, unknown>
}

export interface DagEdge {
  from: string
  to:   string
}

export interface Dag {
  nodes: DagNode[]
  edges: DagEdge[]
}

export interface Run {
  id:                string
  project_id:        string
  status:            RunStatus
  domain_profile:    string
  task_input:        unknown
  dag:               Dag
  cost_actual_usd:   number
  tokens_actual:     number
  budget_usd:        number | null
  started_at:        string | null
  completed_at:      string | null
  created_at:        string
  metadata:          Record<string, unknown>
}

export interface RunNode {
  id:           string
  run_id:       string
  node_id:      string
  agent_type:   string
  status:       NodeStatus
  cost_usd:     number | null
  tokens_in:    number | null
  tokens_out:   number | null
  started_at:   string | null
  completed_at: string | null
  error:        string | null
}

export interface Project {
  id:          string
  name:        string
  description: string | null
  created_at:  string
  updated_at:  string
}

export interface LlmProfile {
  id:           string
  provider:     LlmProvider
  model_string: string
  tier:         LlmTier
  base_url:     string | null
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface AnalyticsSeries {
  ts:   string
  runs: number
  cost: number
}

export interface AnalyticsResult {
  from:             string
  to:               string
  granularity:      'hour' | 'day' | 'week' | 'month'
  runs_total:       number
  runs_completed:   number
  runs_failed:      number
  cost_total_usd:   number
  tokens_total:     number
  avg_cost_per_run: number
  series:           AnalyticsSeries[]
}

// ─── Request / response shapes ────────────────────────────────────────────────

/** POST /api/v1/runs */
export interface CreateRunRequest {
  task_input:        unknown
  domain_profile:    string
  budget_usd?:       number
  budget_tokens?:    number
  transparency_mode?: boolean
  confidentiality?:  string | null
}

export interface CreateRunResponse {
  run: Run
}

/** GET /api/v1/runs/:runId */
export interface GetRunResponse {
  run:   Run
  nodes: RunNode[]
}

/** GET /api/v1/projects */
export interface ListProjectsResponse {
  projects: Project[]
}

/** GET /api/v1/projects/:projectId */
export interface GetProjectResponse {
  project: Project
}

/** GET /api/v1/profiles */
export interface ListProfilesResponse {
  profiles: LlmProfile[]
}

/** GET /api/v1/analytics */
export interface GetAnalyticsResponse extends AnalyticsResult {}

/** GET /api/health */
export interface HealthResponse {
  status: 'ok'
}
