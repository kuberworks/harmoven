// lib/execution/custom/state-machine.ts
// Node and Run state machines — all valid transitions.
// Amendments: 63 (PAUSED), 65 (INTERRUPTED), 34.2 (base spec).
//
// RULE: never mutate status directly — always call transitionNode() / transitionRun().
// This ensures audit log entries and SSE events are always emitted on transitions.

import type { NodeStatus, RunStatus } from '@/types/run.types'

// ─── Node state machine ───────────────────────────────────────────────────────

/** Valid next states for each node status. Source of truth. */
const NODE_TRANSITIONS: Record<NodeStatus, NodeStatus[]> = {
  PENDING:     ['RUNNING', 'BLOCKED'],
  RUNNING:     ['COMPLETED', 'FAILED', 'BLOCKED', 'INTERRUPTED'],
  BLOCKED:     ['PENDING', 'RUNNING'],         // deps completed → unblocked
  FAILED:      ['RUNNING', 'ESCALATED'],       // RUNNING = retry attempt
  ESCALATED:   ['RUNNING', 'SKIPPED'],         // human resolves
  SKIPPED:     [],                             // terminal
  COMPLETED:   ['RUNNING'],                    // only via explicit "Replay node"
  DEADLOCKED:  [],                             // terminal — admin must intervene
  INTERRUPTED: ['RUNNING', 'PENDING', 'COMPLETED'], // Am.65 — resume/replay/accept-partial
}

// ─── Run state machine ────────────────────────────────────────────────────────

/** Valid next states for each run status. */
const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  PENDING:   ['RUNNING'],
  RUNNING:   ['COMPLETED', 'FAILED', 'SUSPENDED', 'PAUSED'],
  PAUSED:    ['RUNNING', 'FAILED'],            // Am.63 — resume or abort
  SUSPENDED: ['RUNNING', 'FAILED'],            // human gate or crash
  FAILED:    ['RUNNING'],                      // admin retry only
  COMPLETED: ['RUNNING'],                      // only via explicit node replay (re-run from completed run)
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string, entityId: string) {
    super(`Invalid transition ${from} → ${to} for entity ${entityId}`)
    this.name = 'InvalidTransitionError'
  }
}

// ─── Guards ───────────────────────────────────────────────────────────────────

/** Returns true if the node transition is valid. */
export function canTransitionNode(from: NodeStatus, to: NodeStatus): boolean {
  return NODE_TRANSITIONS[from]?.includes(to) ?? false
}

/** Returns true if the run transition is valid. */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false
}

/** Asserts node transition is valid; throws InvalidTransitionError if not. */
export function assertNodeTransition(from: NodeStatus, to: NodeStatus, nodeId: string): void {
  if (!canTransitionNode(from, to)) {
    throw new InvalidTransitionError(from, to, nodeId)
  }
}

/** Asserts run transition is valid; throws InvalidTransitionError if not. */
export function assertRunTransition(from: RunStatus, to: RunStatus, runId: string): void {
  if (!canTransitionRun(from, to)) {
    throw new InvalidTransitionError(from, to, runId)
  }
}

// ─── Terminal status helpers ──────────────────────────────────────────────────

/** Node statuses from which no further automatic transitions are possible. */
export const TERMINAL_NODE_STATUSES = new Set<NodeStatus>([
  'COMPLETED',
  'SKIPPED',
  'DEADLOCKED',
])

/** Run statuses from which no further automatic transitions are possible.
 * Note: COMPLETED is NOT in this set — a completed run can be re-opened via node replay.
 * FAILED is included because it requires an explicit admin retry (resumeRun) to re-enter. */
export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'FAILED',
])

/** Returns true if the node is in a terminal state (will not change without manual action). */
export function isTerminalNode(status: NodeStatus): boolean {
  return TERMINAL_NODE_STATUSES.has(status)
}

/** Returns true if the run is in a terminal state. */
export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

/** Returns true if the node is considered "done" for DAG dependency purposes. */
export function isNodeDone(status: NodeStatus): boolean {
  // COMPLETED and SKIPPED unblock downstream nodes.
  // FAILED/ESCALATED/INTERRUPTED are NOT done — they block downstream.
  return status === 'COMPLETED' || status === 'SKIPPED'
}
