// lib/maintenance/run-data-ttl.ts
// RGPD Art.5 §1 e) — Run data content purge after TTL expiry (RGPD-04).
//
// Fields purged when Run.data_expires_at < NOW():
//   Run.task_input        → {} (replaced by empty object sentinel)
//   Run.user_injections   → [] (replaced by empty array sentinel)
//   Node.partial_output   → "" (replaced by empty string) for nodes of expired runs
//   Node.handoff_in       → {} for nodes of expired runs
//   Node.handoff_out      → {} for nodes of expired runs  (via Handoff table)
//
// Node.partial_output and Handoff rows may contain free-form LLM or user text.
// After TTL, the execution artifacts are deleted at field level — the Run row
// itself and its metadata (status, cost, timing) are preserved for analytics.
//
// The TTL is configured via the DATA_RETENTION_DAYS env var (default: 90).
// At run creation, data_expires_at = created_at + DATA_RETENTION_DAYS.
//
// Schedule: daily at 03:30 (after session-cleanup at 03:00).

import cron from 'node-cron'
import { db } from '@/lib/db/client'

export const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS ?? '90', 10)

// Sentinel values for nullified content — clearly machine-generated, enables
// future audits to distinguish "never had content" from "content purged".
const PURGED_OBJECT = { __purged__: true } as const
const PURGED_ARRAY  = [] as const
const PURGED_STRING = ''

export async function purgeExpiredRunData(): Promise<{ runs: number; nodes: number }> {
  const now = new Date()

  // Find all run IDs whose data has expired
  const expiredRuns = await db.run.findMany({
    where:  { data_expires_at: { lt: now } },
    select: { id: true },
  })

  if (expiredRuns.length === 0) {
    return { runs: 0, nodes: 0 }
  }

  const expiredIds = expiredRuns.map(r => r.id)

  // Run both updates in a transaction for consistency
  const [runResult, nodeResult] = await db.$transaction([
    // Nullify Run-level personal data content
    db.run.updateMany({
      where: { id: { in: expiredIds } },
      data:  {
        task_input:      PURGED_OBJECT,
        user_injections: PURGED_ARRAY,
        // Clear data_expires_at to prevent re-processing on next sweep
        data_expires_at: null,
      },
    }),

    // Nullify Node-level LLM content
    db.node.updateMany({
      where: { run_id: { in: expiredIds } },
      data:  {
        partial_output: PURGED_STRING,
        handoff_in:     PURGED_OBJECT,
        handoff_out:    PURGED_OBJECT,
      },
    }),
  ])

  return { runs: runResult.count, nodes: nodeResult.count }
}

/**
 * Computes data_expires_at for a new Run.
 * Call this at Run creation time and include in the `data` payload.
 */
export function computeDataExpiresAt(createdAt: Date = new Date()): Date {
  const expires = new Date(createdAt)
  expires.setDate(expires.getDate() + DATA_RETENTION_DAYS)
  return expires
}

/**
 * Starts the daily run-data TTL cron job.
 * Runs once at startup, then every day at 03:30.
 */
export function startRunDataTtlCron(): cron.ScheduledTask {
  // Startup sweep
  void purgeExpiredRunData().then(({ runs, nodes }) => {
    if (runs > 0) {
      console.info(`[run-data-ttl] Startup sweep: purged content from ${runs} run(s) / ${nodes} node(s).`)
    }
  }).catch((err: unknown) => {
    console.warn('[run-data-ttl] Startup sweep failed (non-fatal):', err)
  })

  const task = cron.schedule('30 3 * * *', () => {
    void purgeExpiredRunData().then(({ runs, nodes }) => {
      console.info(`[run-data-ttl] Daily sweep: purged content from ${runs} run(s) / ${nodes} node(s).`)
    }).catch((err: unknown) => {
      console.warn('[run-data-ttl] Daily sweep failed:', err)
    })
  })

  return task
}
