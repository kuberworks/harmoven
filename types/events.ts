// types/events.ts
// Server-Sent Event (SSE) payload types for Harmoven run streams.
// Spec: TECHNICAL.md §18 (SSE), lib/events/project-event-bus.interface.ts.
//
// These types describe the `data` field of each SSE event emitted on:
//   GET /api/runs/:id/stream
//   GET /api/projects/:id/stream
//
// Clients that support cost events need `stream:costs` permission.
// Clients that support human gate events need `stream:gates` permission.

// ─── Discriminated union ──────────────────────────────────────────────────────

/** Initial snapshot sent on SSE connect (full run state + all node states). */
export type RunSSEEventInitial = {
  type: 'initial'
  /** Full run object as stored in the database. */
  run:   unknown
  /** All node objects for the run. */
  nodes: unknown[]
}

/** Emitted on every run or node status transition. */
export type RunSSEEventStateChange = {
  type:        'state_change'
  entity_type: 'run' | 'node'
  id:          string
  status:      string
}

/** Emitted each time accumulated cost / tokens change for a run. Requires stream:costs. */
export type RunSSEEventCostUpdate = {
  type:              'cost_update'
  cost_usd:          number
  tokens:            number
  percent_of_budget: number
}

/** Emitted when a node is paused at a Human Gate requiring user action. Requires stream:gates. */
export type RunSSEEventHumanGate = {
  type:    'human_gate'
  gate_id: string
  reason:  string
  data:    unknown
}

/** Emitted when accumulated cost approaches the run budget. Requires stream:costs. */
export type RunSSEEventBudgetWarning = {
  type:          'budget_warning'
  percent_used:  number
  remaining_usd: number
}

/** Emitted when the LLM router falls back to a different model for a node. */
export type RunSSEEventLlmFallback = {
  type:    'llm_fallback'
  node_id: string
  from:    string
  to:      string
  reason:  string
}

/** Emitted when a run reaches COMPLETED status. */
export type RunSSEEventCompleted = {
  type:         'completed'
  /** Final run object. */
  run:          unknown
  handoff_note: string
}

/** Emitted when a node or run-level error occurs. */
export type RunSSEEventError = {
  type:    'error'
  node_id: string
  message: string
}

/** Emitted after PYTHON_EXECUTOR artifacts are persisted. */
export type RunSSEEventArtifactsReady = {
  type:           'artifacts_ready'
  node_id:        string
  artifact_count: number
  filenames:      string[]  // for UI display, not for download (use artifact IDs)
}

/** Emitted when the REVIEWER spawns follow-up runs (verdict SPAWN_FOLLOWUP). */
export type RunSSEEventSpawnedFollowupRuns = {
  type:     'spawned_followup_runs'
  /** reviewer node_id that triggered the spawn. */
  node_id:  string
  /** IDs + labels of newly created runs, in order. */
  runs:     Array<{ run_id: string; label: string }>
}

/**
 * Full discriminated union of all SSE event payloads.
 * Parsed from the `data` field of each `text/event-stream` message.
 *
 * @example
 * ```ts
 * const eventSource = new EventSource(`/api/runs/${runId}/stream`)
 * eventSource.onmessage = (e) => {
 *   const event = JSON.parse(e.data) as RunSSEEvent
 *   switch (event.type) {
 *     case 'state_change': console.log(event.status); break
 *     case 'cost_update':  console.log(event.cost_usd); break
 *     // ...
 *   }
 * }
 * ```
 */
export type RunSSEEvent =
  | RunSSEEventInitial
  | RunSSEEventStateChange
  | RunSSEEventCostUpdate
  | RunSSEEventHumanGate
  | RunSSEEventBudgetWarning
  | RunSSEEventLlmFallback
  | RunSSEEventCompleted
  | RunSSEEventError
  | RunSSEEventArtifactsReady
  | RunSSEEventSpawnedFollowupRuns

/** Project-level lifecycle events (emitted on /api/projects/:id/stream). */
export type ProjectLifecycleEvent =
  | { type: 'run_started'; run_id: string; domain_profile: string; task_summary: string }
  | { type: 'run_finished'; run_id: string; status: 'COMPLETED' | 'FAILED' }
