// types/run.types.ts
// Shared run/node status enums and gate types.
// Exported for both backend logic and frontend SSE consumers.

/** Run lifecycle states (Am.63 adds PAUSED). */
export type RunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SUSPENDED'
  | 'PAUSED'

/** Node lifecycle states (Am.65 adds INTERRUPTED). */
export type NodeStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'BLOCKED'
  | 'FAILED'
  | 'ESCALATED'
  | 'SKIPPED'
  | 'COMPLETED'
  | 'DEADLOCKED'
  | 'INTERRUPTED'

/** Human gate lifecycle states. */
export type HumanGateStatus = 'OPEN' | 'RESOLVED' | 'TIMED_OUT'

/** Possible human decisions on a gate. */
export type GateDecision = 'approve' | 'modify' | 'replay_node' | 'abort'

/** Terminal node statuses — once reached, the node cannot change without explicit admin action. */
export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set([
  'COMPLETED',
  'SKIPPED',
  'DEADLOCKED',
])

/** Terminal run statuses. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'COMPLETED',
  'FAILED',
])
