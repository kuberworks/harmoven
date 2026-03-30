// lib/execution/custom/crash-recovery.ts
// Crash recovery on startup — Amendment 34.3a / 34.3b.
//
// Two recovery scenarios:
//   A) Orphan nodes — nodes left RUNNING after an unclean shutdown (no SIGTERM).
//      These are handled by CustomExecutor.recoverOrphans() which marks them
//      INTERRUPTED and suspends their parent runs.
//
//   B) Suspended runs — runs left SUSPENDED by a previous graceful shutdown
//      (SIGTERM was received, markShutdownNodes ran, suspendInterruptedRuns ran).
//      These are explicitly re-queued for execution on startup.
//
// This module is called by createExecutionEngine() after orphan recovery
// finishes. It finds SUSPENDED runs whose suspend_reason indicates a crash or
// shutdown, resets their INTERRUPTED/FAILED nodes to PENDING, and resumes them.
//
// DoD: T1.5 subtask 4 — "crash recovery: on startup, resume RUNNING runs".

import type { IExecutionEngine } from '@/lib/execution/engine.interface'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'

/** Suspend reasons that indicate the run can be auto-resumed after restart. */
const RECOVERABLE_SUSPEND_REASONS = new Set([
  'graceful_shutdown',   // SIGTERM was received — nodes were cleanly suspended
  'orphan_recovery',     // Orphan scan found stale heartbeat nodes
  'crash_recovery',      // Explicit crash marker written before unclean exit
])

/**
 * Resume SUSPENDED runs from a previous process shutdown.
 *
 * Steps:
 *   1. Find SUSPENDED runs with a recoverable suspend_reason.
 *   2. Reset INTERRUPTED and FAILED nodes (due to shutdown) to PENDING.
 *   3. Remove the suspend_reason so the run is clean.
 *   4. Call engine.resumeRun() to re-enter the execution loop.
 *
 * Errors in individual runs are caught and logged — a failure to recover one
 * run must not block recovery of the others.
 *
 * @param engine  The live IExecutionEngine instance (already started).
 * @returns       Number of runs successfully resumed.
 */
export async function resumeSuspendedRunsFromCrash(
  engine: IExecutionEngine,
): Promise<number> {
  let resumed = 0

  // Find all SUSPENDED runs (non-terminal — they can be restarted).
  const suspended = await db.run.findMany({
    where: { status: 'SUSPENDED' },
    select: {
      id:       true,
      metadata: true,
    },
  })

  for (const run of suspended) {
    const meta = (run.metadata ?? {}) as Record<string, unknown>
    const reason = typeof meta['suspend_reason'] === 'string'
      ? meta['suspend_reason']
      : null

    if (!reason || !RECOVERABLE_SUSPEND_REASONS.has(reason)) continue

    try {
      // Reset nodes that were interrupted by the previous shutdown.
      // These may be INTERRUPTED (orphan path) or FAILED (shutdown path).
      await db.node.updateMany({
        where: {
          run_id: run.id,
          status: { in: ['INTERRUPTED', 'FAILED'] },
          // Only reset nodes that were explicitly marked by shutdown/orphan,
          // not nodes that failed due to LLM/agent errors.
          OR: [
            { interrupted_by: 'orphan_detection' },
            { interrupted_by: null },
          ],
        },
        data: {
          status:         'PENDING',
          error:          null,
          interrupted_at: null,
          interrupted_by: null,
        },
      })

      // Clear the suspend_reason so it does not trigger re-recovery.
      await db.run.update({
        where: { id: run.id },
        data: {
          metadata: {
            ...meta,
            suspend_reason:         undefined,
            resumed_after_crash_at: new Date().toISOString(),
          },
        },
      })

      await db.auditLog.create({
        data: {
          id:          uuidv7(),
          run_id:      run.id,
          actor:       'system',
          action_type: 'run_crash_recovery',
          payload: {
            original_suspend_reason: reason,
            resumed_at:              new Date().toISOString(),
          },
        },
      })

      // Re-enter the execution loop for this run.
      await engine.resumeRun(run.id, 'system')
      resumed++

      console.info(
        `[crash-recovery] resumed run ${run.id} (was suspended: ${reason})`,
      )
    } catch (err) {
      console.error(
        `[crash-recovery] failed to resume run ${run.id}:`,
        err,
      )
    }
  }

  if (resumed > 0) {
    console.info(`[crash-recovery] resumed ${resumed} run(s) from previous crash`)
  }

  return resumed
}

/**
 * Reset stale RUNNING runs (engine lost during startup before any node ran).
 *
 * A run can be left in RUNNING status with all nodes PENDING if the process
 * was killed after `transitionRun(PENDING→RUNNING)` but before any node
 * started. These runs are invisible to SUSPENDED recovery above.
 *
 * Fix: reset them back to PENDING and re-execute via the engine.
 */
export async function resetStaleRunningRuns(engine: IExecutionEngine): Promise<number> {
  // Find RUNNING runs that have zero RUNNING nodes — they are stuck.
  const staleRuns = await db.$queryRaw<Array<{ id: string }>>`
    SELECT r.id
    FROM "Run" r
    WHERE r.status = 'RUNNING'
      AND NOT EXISTS (
        SELECT 1 FROM "Node" n
        WHERE n.run_id = r.id AND n.status = 'RUNNING'
      )
  `

  let restarted = 0
  for (const run of staleRuns) {
    try {
      await db.run.update({
        where: { id: run.id },
        data: { status: 'PENDING', started_at: null },
      })
      await db.node.updateMany({
        where: { run_id: run.id, status: { in: ['INTERRUPTED', 'FAILED'] } },
        data: { status: 'PENDING', error: null, interrupted_at: null, interrupted_by: null },
      })
      await db.auditLog.create({
        data: {
          id:          uuidv7(),
          run_id:      run.id,
          actor:       'system',
          action_type: 'run_stale_reset',
          payload:     { reason: 'stale_running_no_active_nodes' },
        },
      })
      console.info(`[crash-recovery] reset stale RUNNING run ${run.id} → PENDING, re-executing`)
      void engine.executeRun(run.id).catch((err: unknown) => {
        console.error(`[crash-recovery] re-execute failed for stale run ${run.id}:`, err)
      })
      restarted++
    } catch (err) {
      console.error(`[crash-recovery] failed to reset stale run ${run.id}:`, err)
    }
  }

  if (restarted > 0) {
    console.info(`[crash-recovery] restarted ${restarted} stale RUNNING run(s)`)
  }
  return restarted
}
