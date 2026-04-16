// lib/maintenance/run-data-ttl.ts
// RGPD Art.5 §1 e) — Run data content purge after TTL expiry (RGPD-04).
//
// Fields purged when Run.data_expires_at < NOW():
//   Run.task_input        → {} (replaced by empty object sentinel)
//   Run.user_injections   → [] (replaced by empty array sentinel)
//   Node.partial_output   → "" (replaced by empty string) for nodes of expired runs
//   Node.handoff_in       → {} for nodes of expired runs
//   Node.handoff_out      → {} for nodes of expired runs
//
// The TTL is configured via PATCH /api/admin/rgpd (data_retention_days, default 90).
// Env var DATA_RETENTION_DAYS is the fallback when no DB setting exists.
// At run creation, data_expires_at = created_at + data_retention_days.
//
// Schedule: daily at 03:30 (after session-cleanup at 03:00).
// Toggle:   configurable at runtime via PATCH /api/admin/rgpd (instance_admin).
//           The data_expires_at field is still written at run creation regardless —
//           it just won't be acted upon when maintenance is disabled.

import cron from 'node-cron'
import { db }             from '@/lib/db/client'
import { getRgpdConfig } from '@/lib/maintenance/rgpd-config'

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
 * The cron itself always starts; it checks the live admin config at each sweep.
 */
export function startRunDataTtlCron(): cron.ScheduledTask {
  async function sweep(context: 'startup' | 'daily') {
    const { maintenance_enabled } = await getRgpdConfig()
    if (!maintenance_enabled) {
      if (context === 'startup') {
        console.warn('[run-data-ttl] Maintenance disabled (admin config) — run data TTL purge skipped.')
      }
      return
    }
    const { runs, nodes } = await purgeExpiredRunData()
    if (runs > 0 || context === 'startup') {
      console.info(`[run-data-ttl] ${context} sweep: purged content from ${runs} run(s) / ${nodes} node(s).`)
    }
  }

  // Startup sweep
  void sweep('startup').catch((err: unknown) =>
    console.warn('[run-data-ttl] Startup sweep failed (non-fatal):', err),
  )

  return cron.schedule('30 3 * * *', () => {
    void sweep('daily').catch((err: unknown) =>
      console.warn('[run-data-ttl] Daily sweep failed:', err),
    )
  })
}
