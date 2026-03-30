// app/api/runs/[runId]/critical-fix/route.ts
// POST /api/runs/:runId/critical-fix
// Launches a targeted Writer fix agent for a single critical finding.
// Budget cap: $0.10 | max_tokens: 2000 (Section 27.7)
//
// Auth: gates:read_critical permission required.
// The targeted fix re-runs both Standard Reviewer and CriticalReviewer after completion.
// Idempotent for the same finding_id — creates/updates CriticalFindingFix row.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'

// ─── Zod schema ─────────────────────────────────────────────────────────────
// finding is a nested object — validate the fields we use (title, severity).
// Max sizes prevent DoS via oversized payloads.
const CriticalFindingSchema = z.object({
  title:       z.string().min(1).max(500),
  severity:    z.enum(['critical', 'high', 'medium', 'low']),
  description: z.string().max(5_000).optional(),
  location:    z.string().max(500).optional(),
}).passthrough()  // allow extra fields from CriticalFinding type

const CriticalFixBodySchema = z.object({
  finding_id: z.string().min(1).max(128),
  finding:    CriticalFindingSchema,
  result_id:  z.string().min(1).max(128),
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

  // ─── Parse + validate body (C-02: Zod strict) ────────────────────────────────
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = CriticalFixBodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const { finding_id, finding, result_id } = parsed.data

  // ─── Validate that result_id belongs to this run ───────────────────────────
  const reviewResult = await (db as any).criticalReviewResult.findUnique({
    where: { id: result_id },
    select: { run_id: true },
  })
  if (!reviewResult || reviewResult.run_id !== runId) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  // ─── Create / update fix record ────────────────────────────────────────────
  // Idempotent: reuse existing record if one exists for this finding_id on this result
  const existingFix = await (db as any).criticalFindingFix.findFirst({
    where: { result_id, finding_id },
    select: { id: true, status: true },
  })

  let fixRecord: { id: string }
  if (existingFix) {
    // Reset to pending if it previously failed
    if (existingFix.status === 'failed') {
      fixRecord = await (db as any).criticalFindingFix.update({
        where: { id: existingFix.id },
        data: { status: 'pending', fix_run_id: null },
        select: { id: true },
      })
    } else {
      // already pending or fixed — return current state
      return NextResponse.json({ fix_id: existingFix.id, status: existingFix.status })
    }
  } else {
    fixRecord = await (db as any).criticalFindingFix.create({
      data: {
        result_id,
        finding_id,
        status:   'pending',
        cost_usd: 0,
      },
      select: { id: true },
    })
  }

  // ─── Audit log ─────────────────────────────────────────────────────────────
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      run_id:      runId,
      actor:       actorId,
      action_type: 'critical_fix_requested',
      payload: {
        finding_id,
        finding_title: finding.title,
        finding_severity: finding.severity,
        result_id,
        fix_id: fixRecord.id,
      },
    },
  })

  // NOTE: In production the fix agent would be dispatched asynchronously
  // (via a background job queue). For v1 the fix_id is returned and the
  // caller polls /api/runs/:runId/critical-fix/:fixId for status.
  // The fix_run_id will be populated by the background worker once it
  // creates a child run for the targeted Writer agent.

  return NextResponse.json({ fix_id: fixRecord.id, status: 'pending' })
}
