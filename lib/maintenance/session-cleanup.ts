// lib/maintenance/session-cleanup.ts
// RGPD Art.5 §1 e) — Purge expired sessions (RGPD-03).
//
// Session rows retain ipAddress and userAgent (personal data, CJUE C-582/14).
// Better Auth expires sessions logically (via expiresAt) but never purges them
// physically. This job deletes rows whose expiresAt is in the past.
//
// Schedule: daily at 03:00 (low-traffic window).
// Toggle:   configurable at runtime via PATCH /api/admin/rgpd (instance_admin).
//           Env var RGPD_MAINTENANCE_ENABLED=false overrides the DB setting.
// Note: node-cron runs in-process; in a multi-instance deployment use a
// distributed lock or move this to a separate worker. For now, the risk of
// duplicate runs is a double-deletion attempt on the same expired rows — which
// is idempotent and harmless.

import cron from 'node-cron'
import { db }             from '@/lib/db/client'
import { getRgpdConfig } from '@/lib/maintenance/rgpd-config'

/** Purge expired sessions. Returns the number of rows deleted. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await db.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return result.count
}

/**
 * Starts the daily session-cleanup cron job.
 * The cron itself always starts; it checks the live admin config at each sweep.
 * Returns the cron task handle (call .stop() to cancel in tests).
 */
export function startSessionCleanupCron(): cron.ScheduledTask {
  async function sweep(context: 'startup' | 'daily') {
    const { maintenance_enabled } = await getRgpdConfig()
    if (!maintenance_enabled) {
      if (context === 'startup') {
        console.warn('[session-cleanup] Maintenance disabled (admin config) — session purge skipped.')
      }
      return
    }
    const count = await purgeExpiredSessions()
    if (count > 0 || context === 'startup') {
      console.info(`[session-cleanup] ${context} sweep: purged ${count} expired session(s).`)
    }
  }

  // Run once at startup to catch any backlog from server downtime.
  void sweep('startup').catch((err: unknown) =>
    console.warn('[session-cleanup] Startup sweep failed (non-fatal):', err),
  )

  // Schedule daily at 03:00 server time.
  return cron.schedule('0 3 * * *', () => {
    void sweep('daily').catch((err: unknown) =>
      console.warn('[session-cleanup] Daily sweep failed:', err),
    )
  })
}
