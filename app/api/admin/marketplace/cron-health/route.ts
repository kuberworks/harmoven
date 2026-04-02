// app/api/admin/marketplace/cron-health/route.ts
// GET /api/admin/marketplace/cron-health
// Return cron health state + last run summary.
//
// B.5.5 / L14 — SEC-48, SEC-53, SEC-61

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'

// Health states (B.5.5)
// OK           → last_scheduled_run_at within expected window, 0 pending updates
// UPDATES_AVAILABLE → ≥1 skills have pending_update non-null
// STALE        → last_scheduled_run_at > 2× CHECK_INTERVAL_SECONDS + 5 min ago (broken cron schedule)
// DELAYED      → last_scheduled_run_at > CHECK_INTERVAL_SECONDS + 5 min ago
// ERROR        → last_run_status contains "error"
// NOT_CONFIGURED → INTERNAL_CRON_SECRET not set (cron endpoint always 503)

const DEFAULT_INTERVAL_S = 86400 // 24h

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    assertInstanceAdmin(caller) // SEC-61
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    throw err
  }

  const [
    lastRunAt,
    lastRunStatus,
    lastRunSummary,
    lastScheduledRunAt,
  ] = await Promise.all([
    db.systemSetting.findUnique({ where: { key: 'marketplace.cron.last_run_at' } }),
    db.systemSetting.findUnique({ where: { key: 'marketplace.cron.last_run_status' } }),
    db.systemSetting.findUnique({ where: { key: 'marketplace.cron.last_run_summary' } }),
    db.systemSetting.findUnique({ where: { key: 'marketplace.cron.last_scheduled_run_at' } }),
  ])

  const pendingUpdatesCount = await db.mcpSkill.count({
    where: { pending_update: { not: undefined } },
  })

  const intervalS = parseInt(process.env.CHECK_INTERVAL_SECONDS ?? String(DEFAULT_INTERVAL_S), 10)
  const cronConfigured = !!process.env.INTERNAL_CRON_SECRET

  const now = Date.now()
  const scheduledAt = lastScheduledRunAt?.value ? new Date(lastScheduledRunAt.value).getTime() : null

  let health: 'OK' | 'UPDATES_AVAILABLE' | 'STALE' | 'DELAYED' | 'ERROR' | 'NOT_CONFIGURED'

  if (!cronConfigured) {
    health = 'NOT_CONFIGURED'
  } else if (lastRunStatus?.value?.startsWith('error')) {
    health = 'ERROR'
  } else if (scheduledAt !== null && now - scheduledAt > (2 * intervalS + 300) * 1000) {
    health = 'STALE' // SEC-53: evaluated against last_scheduled_run_at only
  } else if (scheduledAt !== null && now - scheduledAt > (intervalS + 300) * 1000) {
    health = 'DELAYED'
  } else if (pendingUpdatesCount > 0) {
    health = 'UPDATES_AVAILABLE'
  } else {
    health = 'OK'
  }

  return NextResponse.json({
    health,
    last_run_at:            lastRunAt?.value ?? null,
    last_scheduled_run_at:  lastScheduledRunAt?.value ?? null,
    last_run_status:        lastRunStatus?.value ?? null,
    last_run_summary:       lastRunSummary?.value ? JSON.parse(lastRunSummary.value) : null,
    pending_updates_count:  pendingUpdatesCount,
    check_interval_seconds: intervalS,
  })
}
