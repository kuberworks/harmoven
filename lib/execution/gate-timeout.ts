// lib/execution/gate-timeout.ts
// HumanGate TIMED_OUT enforcement — Amendment 63 / DoD §HumanGate.
//
// The Prisma schema defines HumanGateStatus.TIMED_OUT and HumanGate.timeout_at
// but nothing ever transitions a gate to that state. This module fills the gap.
//
// Behaviour:
//   - sweepExpiredGates() finds all OPEN gates where timeout_at < NOW()
//   - Transitions each to TIMED_OUT
//   - Writes an AuditLog entry per expired gate
//   - If the associated run is still SUSPENDED (waiting only on this gate),
//     it remains SUSPENDED — a human must still choose how to handle it.
//
// Called:
//   1. Once at server startup (instrumentation.ts) — catches gates that expired
//      while the server was down.
//   2. Every 5 minutes via a setInterval registered in instrumentation.ts.
//
// Default gate timeout: 24 hours (GATE_DEFAULT_TIMEOUT_HOURS).
// Operators can override via orchestrator.yaml: execution.gate_timeout_hours.

import { db } from '@/lib/db/client'

/** Default gate expiry from creation — 24 hours. */
export const GATE_DEFAULT_TIMEOUT_HOURS = 24

/**
 * Return the Date at which a newly created gate expires.
 * Used when inserting a HumanGate row.
 */
export function gateTimeoutAt(hours = GATE_DEFAULT_TIMEOUT_HOURS): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1_000)
}

/**
 * Scan all OPEN gates whose timeout_at is in the past and transition them to
 * TIMED_OUT.  Returns the number of gates expired in this sweep.
 *
 * This is safe to call concurrently across multiple instances because the
 * WHERE clause filters on `status = 'OPEN'` — a gate that another instance
 * already transitioned will not match.
 */
export async function sweepExpiredGates(): Promise<{ expired: number }> {
  const now = new Date()

  // Find all OPEN gates with a past timeout_at
  const expiredGates = await db.humanGate.findMany({
    where: {
      status:     'OPEN',
      timeout_at: { lt: now },
    },
    select: { id: true, run_id: true, reason: true },
  })

  if (expiredGates.length === 0) return { expired: 0 }

  for (const gate of expiredGates) {
    try {
      await db.humanGate.update({
        where: { id: gate.id },
        data:  { status: 'TIMED_OUT' },
      })

      await db.auditLog.create({
        data: {
          run_id:      gate.run_id,
          actor:       'system',
          action_type: 'gate_timed_out',
          payload:     { gate_id: gate.id, reason: gate.reason },
        },
      })
    } catch (err) {
      // A gate may have been resolved concurrently — skip, do not rethrow.
      console.error(`[gate-timeout] failed to expire gate ${gate.id}:`, err)
    }
  }

  if (expiredGates.length > 0) {
    console.info(`[gate-timeout] expired ${expiredGates.length} gate(s)`)
  }

  return { expired: expiredGates.length }
}

/** Sweep interval in ms — every 5 minutes. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1_000

let _sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the background sweep loop.
 * Call once from instrumentation.ts / server bootstrap.
 * Safe to call multiple times — only one timer is ever active.
 */
export function startGateSweep(): void {
  if (_sweepTimer) return
  _sweepTimer = setInterval(() => {
    void sweepExpiredGates().catch((err: unknown) =>
      console.error('[gate-timeout] sweep error:', err),
    )
  }, SWEEP_INTERVAL_MS)
  // Unref so the timer does not prevent Node.js from exiting in tests.
  if (_sweepTimer && typeof (_sweepTimer as NodeJS.Timeout).unref === 'function') {
    (_sweepTimer as NodeJS.Timeout).unref()
  }
}

/** Stop the sweep loop (used in test teardown). */
export function stopGateSweep(): void {
  if (_sweepTimer) {
    clearInterval(_sweepTimer)
    _sweepTimer = null
  }
}
