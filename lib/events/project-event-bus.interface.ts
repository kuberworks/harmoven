// lib/events/project-event-bus.interface.ts
// IProjectEventBus — stable contract for all event bus implementations.
// Spec: TECHNICAL.md Section 29, Amendment 79.

import type { RunStatus } from '@/types/run.types'

// ─── Event types ──────────────────────────────────────────────────────────────

/** Mirror of GET /api/runs/:runId/stream SSE event types. */
export type RunSSEEvent =
  | { type: 'initial';        run: unknown; nodes: unknown[] }
  | { type: 'state_change';   entity_type: 'run' | 'node'; id: string; status: string }
  | { type: 'cost_update';    cost_usd: number; tokens: number; percent_of_budget: number }
  | { type: 'human_gate';     gate_id: string; reason: string; data: unknown }
  | { type: 'budget_warning'; percent_used: number; remaining_usd: number }
  | { type: 'llm_fallback';   node_id: string; from: string; to: string; reason: string }
  | { type: 'completed';      run: unknown; handoff_note: string }
  | { type: 'error';          node_id: string; message: string }

export type ProjectLifecycleEvent =
  | { type: 'run_started';  profile: string; task_summary: string }
  | { type: 'run_finished'; status: RunStatus }
  | { type: 'gate_opened';  gate_id: string; reason: string }

export interface ProjectEvent {
  project_id: string
  run_id: string
  event: RunSSEEvent | ProjectLifecycleEvent
  emitted_at: Date
}

/** Dispose function returned by subscribe(). Call to stop receiving events. */
export type Unsubscribe = () => void

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IProjectEventBus {
  /**
   * Emit an event. Persists to EventPayload table for large events and
   * reconnect buffer. No-op if close() has been called.
   */
  emit(event: ProjectEvent): Promise<void>

  /**
   * Subscribe to all events for a project.
   * Returns an Unsubscribe function. Call it to stop receiving events.
   * UNLISTEN from PG channel when last subscriber for a project unsubscribes.
   */
  subscribe(project_id: string, handler: (e: ProjectEvent) => void): Unsubscribe

  /** Graceful shutdown — closes PG listener connection. */
  close(): Promise<void>

  /** Health check — resolves true when the bus is operational. */
  isAvailable(): Promise<boolean>
}
