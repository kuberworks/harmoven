// lib/maintenance/session-cleanup.ts
// RGPD Art.5 §1 e) — Purge expired sessions (RGPD-03).
//
// Session rows retain ipAddress and userAgent (personal data, CJUE C-582/14).
// Better Auth expires sessions logically (via expiresAt) but never purges them
// physically. This job deletes rows whose expiresAt is in the past.
//
// Schedule: daily at 03:00 (low-traffic window).
// Toggle:   RGPD_MAINTENANCE_ENABLED=false disables the cron at startup (see instrumentation.ts).
// Note: node-cron runs in-process; in a multi-instance deployment use a
// distributed lock or move this to a separate worker. For now, the risk of
// duplicate runs is a double-deletion attempt on the same expired rows — which
// is idempotent and harmless.

import cron from 'node-cron'
import { db } from '@/lib/db/client'

/** How many rows are purged per sweep — used for logging. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await db.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  })
  return result.count
}

/**
 * Starts the daily session-cleanup cron job.
 * Runs immediately once at startup, then every day at 03:00.
 * Returns the cron task handle (call .stop() to cancel in tests).
 */
export function startSessionCleanupCron(): cron.ScheduledTask {
  // Run once at startup to catch any backlog from server downtime.
  void purgeExpiredSessions().then(count => {
    if (count > 0) {
      console.info(`[session-cleanup] Purged ${count} expired session(s) at startup.`)
    }
  }).catch((err: unknown) => {
    console.warn('[session-cleanup] Startup sweep failed (non-fatal):', err)
  })

  // Schedule daily at 03:00 server time.
  const task = cron.schedule('0 3 * * *', () => {
    void purgeExpiredSessions().then(count => {
      console.info(`[session-cleanup] Daily sweep: purged ${count} expired session(s).`)
    }).catch((err: unknown) => {
      console.warn('[session-cleanup] Daily sweep failed:', err)
    })
  })

  return task
}
