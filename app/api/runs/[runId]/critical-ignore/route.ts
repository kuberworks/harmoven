// app/api/runs/[runId]/critical-ignore/route.ts
// POST /api/runs/:runId/critical-ignore
// Records an ignored critical finding in the audit log and CriticalFindingIgnore table.
// Once ignored, a finding must still be visible in the UI (immutable record).
//
// Auth: gates:read_critical permission required.
// CriticalFindingIgnore rows are immutable (DB rules in migration SQL).

import { NextRequest, NextResponse } from 'next/server'
import { z }                          from 'zod'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'

// ─── Zod schema ───────────────────────────────────────────────────────────────
// Mirrors the CriticalFinding shape validated in critical-fix/route.ts.
// Max sizes prevent oversized payloads from being persisted in the ignore record
// and the audit log (DB DoS via JSONB).
const CriticalFindingSchema = z.object({
  title:       z.string().min(1).max(500),
  severity:    z.enum(['critical', 'high', 'medium', 'low']),
  description: z.string().max(5_000).optional(),
  location:    z.string().max(500).optional(),
  domain:      z.string().max(128).optional(),
}).passthrough()  // allow extra fields from CriticalFinding type

const CriticalIgnoreBodySchema = z.object({
  finding_id: z.string().min(1).max(128),
  finding:    CriticalFindingSchema,
  result_id:  z.string().uuid(),
}).strict()

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

  // ─── Parse + validate body (Zod strict schema) ────────────────────────────
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = CriticalIgnoreBodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const { finding_id, finding, result_id } = parsed.data

  // ─── Validate that result_id belongs to this run ───────────────────────────
  const reviewResult = await db.criticalReviewResult.findUnique({
    where: { id: result_id },
    select: { run_id: true },
  })
  if (!reviewResult || reviewResult.run_id !== runId) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  // ─── Idempotency guard — don't double-ignore ────────────────────────────────
  const existing = await db.criticalFindingIgnore.findFirst({
    where: { result_id, finding_id },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json({ ignore_id: existing.id, already_ignored: true })
  }

  // ─── actor resolution ──────────────────────────────────────────────────────
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  // ─── Record ignore (immutable) ─────────────────────────────────────────────
  const ignoreRecord = await db.criticalFindingIgnore.create({
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
