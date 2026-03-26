// lib/events/emit-gate.ts
// Utility for emitting HumanGate events to both the run-level SSE stream
// (via RunSSEEvent 'human_gate') and the project-level SSE stream
// (via ProjectLifecycleEvent 'gate_opened').
//
// Called by:
//   - Gate creation route handlers (T3.2): app/api/runs/[id]/gate/route.ts
//   - Interrupt Gate handler (Am.65): app/api/runs/[id]/nodes/[nodeId]/gate/route.ts
//
// Both SSE routes (run-level and project-level) filter 'human_gate' events
// by the caller's `stream:gates` permission (Am.78.6).

import { projectEventBus } from '@/lib/events/project-event-bus.factory'
import type { ProjectEvent } from '@/lib/events/project-event-bus.interface'

export interface EmitHumanGateOptions {
  projectId: string
  runId:     string
  gateId:    string
  reason:    string
  /** Any extra data shown to the gate reviewer (node output, context, etc.) */
  data?:     unknown
}

/**
 * Emit a HumanGate event to ALL subscribers of the project event bus.
 *
 * The run-level SSE route filters by run_id, so only the correct run receives it.
 * The project-level SSE route receives gate_opened lifecycle events for dashboards.
 *
 * Fire-and-forget: the caller does not need to await this.
 * A gate event failure must never block the gate creation response.
 */
export function emitHumanGateEvent(opts: EmitHumanGateOptions): void {
  const { projectId, runId, gateId, reason, data } = opts

  // human_gate → received by the run-level SSE subscriber (filtered by stream:gates)
  const runEvent: ProjectEvent = {
    project_id: projectId,
    run_id:     runId,
    event: {
      type:    'human_gate',
      gate_id: gateId,
      reason,
      data:    data ?? null,
    },
    emitted_at: new Date(),
  }

  // gate_opened → received by the project-level SSE subscriber (dashboards)
  const projectEvent: ProjectEvent = {
    project_id: projectId,
    run_id:     runId,
    event: {
      type:    'gate_opened',
      gate_id: gateId,
      reason,
    },
    emitted_at: new Date(),
  }

  // Emit both — the bus deduplicates if needed (InMemoryEventBus / PgNotifyEventBus
  // deliver to subscribers; the run-level route ignores gate_opened and vice versa).
  void projectEventBus.emit(runEvent).catch((err: unknown) => {
    console.error(`[emit-gate] failed to emit human_gate for gate ${gateId}:`, err)
  })
  void projectEventBus.emit(projectEvent).catch((err: unknown) => {
    console.error(`[emit-gate] failed to emit gate_opened for gate ${gateId}:`, err)
  })
}
