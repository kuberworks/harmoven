// app/api/runs/[runId]/critical-ignore/route.ts
// POST /api/runs/:runId/critical-ignore
// Records an ignored critical finding in the audit log and CriticalFindingIgnore table.
// Once ignored, a finding must still be visible in the UI (immutable record).
//
// Auth: gates:read_critical permission required.
// CriticalFindingIgnore rows are immutable (DB rules in migration SQL).

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'
import type { CriticalFinding } from '@/lib/agents/reviewer/critical-reviewer.types'

interface CriticalIgnoreBody {
  finding_id: string
  finding:    CriticalFinding
  result_id:  string // CriticalReviewResult.id
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ─── IDOR guard ────────────────────────────────────────────────────────────
  const runLookup = await db.run.findUnique({
    where: { id: runId },
    select: { project_id: true },
  })
  if (!runLookup) return NextResponse.json({ error: 'Not Found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, runLookup.project_id)
    await assertRunAccess(runId, runLookup.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'     }, { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, runLookup.project_id)
  if (!perms.has('gates:read_critical')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Parse body ────────────────────────────────────────────────────────────
  let body: CriticalIgnoreBody
  try {
    body = await req.json() as CriticalIgnoreBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { finding_id, finding, result_id } = body
  if (!finding_id || !finding || !result_id) {
    return NextResponse.json({ error: 'Missing required fields: finding_id, finding, result_id' }, { status: 400 })
  }

  // ─── Validate that result_id belongs to this run ───────────────────────────
  const reviewResult = await (db as any).criticalReviewResult.findUnique({
    where: { id: result_id },
    select: { run_id: true },
  })
  if (!reviewResult || reviewResult.run_id !== runId) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  // ─── Idempotency guard — don't double-ignore ────────────────────────────────
  const existing = await (db as any).criticalFindingIgnore.findFirst({
    where: { result_id, finding_id },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json({ ignore_id: existing.id, already_ignored: true })
  }

  // ─── actor resolution ──────────────────────────────────────────────────────
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  // ─── Record ignore (immutable) ─────────────────────────────────────────────
  const ignoreRecord = await (db as any).criticalFindingIgnore.create({
    data: {
      result_id,
      finding_id,
      finding: finding as object,
      ignored_by: actorId,
    },
    select: { id: true },
  })

  // ─── Audit log ─────────────────────────────────────────────────────────────
  // Section 27.6: "HANDOFF_NOTE mentions ignored critical findings"
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      run_id:      runId,
      actor:       actorId,
      action_type: 'critical_finding_ignored',
      payload: {
        finding_id,
        finding_title:    finding.title,
        finding_severity: finding.severity,
        finding_domain:   finding.domain,
        result_id,
        ignore_id:        ignoreRecord.id,
      },
    },
  })

  return NextResponse.json({ ignore_id: ignoreRecord.id, already_ignored: false })
}
