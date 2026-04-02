// app/api/internal/run-update-checks/route.ts
// POST /api/internal/run-update-checks
// B.5.2 — SEC-48, SEC-49, SEC-50
//
// Auth: X-Cron-Secret header (cron container) OR authenticated instance admin session (UI "Lancer maintenant").
// Constant-time comparison for cron secret.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { runUpdateChecks } from '@/lib/marketplace/update-checker'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin } from '@/lib/auth/rbac'

const DEFAULT_MAX_PER_RUN = 50

/** Constant-time string comparison to prevent timing attacks (SEC-48). */
function safeCompare(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ab.length !== bb.length) {
      // Pad to equal length so timingSafeEqual doesn't throw
      const maxLen = Math.max(ab.length, bb.length)
      const padA = Buffer.concat([ab, Buffer.alloc(maxLen - ab.length)])
      const padB = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)])
      timingSafeEqual(padA, padB) // run regardless — don't short-circuit
      return false                // lengths differ: mismatch
    }
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await db.systemSetting.upsert({
    where:  { key },
    create: { key, value },
    update: { value },
  })
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.INTERNAL_CRON_SECRET

  // SEC-48: if INTERNAL_CRON_SECRET not set, endpoint always returns 503
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_NOT_CONFIGURED' }, { status: 503 })
  }

  // Accept either cron secret (container) or authenticated admin session (UI)
  const headerSecret = req.headers.get('x-cron-secret')
  let isCronRequest = false
  let isAdminRequest = false

  if (headerSecret !== null) {
    // Constant-time compare (SEC-48)
    isCronRequest = safeCompare(headerSecret, cronSecret)
    if (!isCronRequest) {
      return NextResponse.json({}, { status: 401 }) // SEC-48: no reason in body
    }
  } else {
    // Try session auth (for "Lancer maintenant" button — SEC-53)
    try {
      const caller = await resolveCaller(req)
      if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      assertInstanceAdmin(caller)
      isAdminRequest = true
    } catch {
      return NextResponse.json({}, { status: 401 })
    }
  }

  const maxPerRunSetting = await db.systemSetting.findUnique({
    where: { key: 'marketplace.update_check.max_per_run' },
  })
  const maxPerRun = parseInt(maxPerRunSetting?.value ?? String(DEFAULT_MAX_PER_RUN), 10)

  // Write last_scheduled_run_at only for actual cron requests (SEC-53)
  if (isCronRequest) {
    await upsertSetting('marketplace.cron.last_scheduled_run_at', new Date().toISOString())
  }

  const summary = await runUpdateChecks(maxPerRun)

  const now = new Date().toISOString()
  const status = summary.errors > 0 ? `error: ${summary.errors} error(s)` : 'ok'

  await Promise.all([
    upsertSetting('marketplace.cron.last_run_at', now),
    upsertSetting('marketplace.cron.last_run_status', status),
    upsertSetting('marketplace.cron.last_run_summary', JSON.stringify(summary)),
  ])

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       isAdminRequest ? 'admin_manual' : 'cron',
      action_type: 'marketplace_cron_run',
      payload:     summary,
    },
  })

  return NextResponse.json({
    checked: summary.checked,
    updated: summary.updated,
    errors:  summary.errors,
  })
}
