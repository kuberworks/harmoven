// app/api/runs/[runId]/feedback/route.ts
// PATCH /api/runs/:runId/feedback
// Post-completion user feedback — Amendment 85.2.
//
// Non-blocking optional micro-prompt: user_rating (1-5), estimated_hours_saved, business_value_note.
// Requires: runs:read permission on the run's project.
// Constraint: run must be in COMPLETED status.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'

// M-1: Zod schema replaces manual validation — caps business_value_note, enforces all types.
const FeedbackBody = z.object({
  user_rating:           z.number().int().min(1).max(5).optional(),
  estimated_hours_saved: z.number().min(0).optional(),
  business_value_note:   z.string().max(2000).optional(),
}).strict().refine(
  d => d.user_rating !== undefined || d.estimated_hours_saved !== undefined || d.business_value_note !== undefined,
  { message: 'At least one of user_rating, estimated_hours_saved, or business_value_note is required' },
)

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ─── Run lookup ────────────────────────────────────────────────────────────
  const run = await db.run.findUnique({
    where:  { id: runId },
    select: { project_id: true, status: true },
  })
  if (!run) return NextResponse.json({ error: 'Not Found' }, { status: 404 })

  // ─── Project access ────────────────────────────────────────────────────────
  try {
    await assertProjectAccess(caller, run.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden' },    { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, run.project_id)
  if (!perms.has('runs:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Status guard ──────────────────────────────────────────────────────────
  if (run.status !== 'COMPLETED') {
    return NextResponse.json(
      { error: 'Feedback can only be submitted for COMPLETED runs' },
      { status: 409 },
    )
  }

  // ─── Body parse + validation (Zod) ────────────────────────────────────────
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = FeedbackBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { user_rating, estimated_hours_saved, business_value_note } = parsed.data

  // ─── Persist ───────────────────────────────────────────────────────────────
  const updateData: Record<string, unknown> = {}
  if (user_rating          !== undefined) updateData.user_rating           = user_rating
  if (estimated_hours_saved !== undefined) updateData.estimated_hours_saved = estimated_hours_saved
  if (business_value_note  !== undefined) updateData.business_value_note   = business_value_note

  await db.run.update({
    where: { id: runId },
    data:  updateData,
  })

  return NextResponse.json({ ok: true, run_id: runId })
}
