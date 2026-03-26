// app/api/runs/[runId]/feedback/route.ts
// PATCH /api/runs/:runId/feedback
// Post-completion user feedback — Amendment 85.2.
//
// Non-blocking optional micro-prompt: user_rating (1-5), estimated_hours_saved, business_value_note.
// Requires: runs:read permission on the run's project.
// Constraint: run must be in COMPLETED status.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'

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

  // ─── Body parse ────────────────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { user_rating, estimated_hours_saved, business_value_note } = body

  // Validate user_rating if provided
  if (user_rating !== undefined) {
    if (
      typeof user_rating !== 'number' ||
      !Number.isInteger(user_rating) ||
      user_rating < 1 ||
      user_rating > 5
    ) {
      return NextResponse.json(
        { error: 'user_rating must be an integer between 1 and 5' },
        { status: 400 },
      )
    }
  }

  // Validate estimated_hours_saved if provided
  if (estimated_hours_saved !== undefined) {
    if (typeof estimated_hours_saved !== 'number' || estimated_hours_saved < 0) {
      return NextResponse.json(
        { error: 'estimated_hours_saved must be a non-negative number' },
        { status: 400 },
      )
    }
  }

  // Validate business_value_note if provided
  if (business_value_note !== undefined && typeof business_value_note !== 'string') {
    return NextResponse.json(
      { error: 'business_value_note must be a string' },
      { status: 400 },
    )
  }

  // At least one feedback field required
  if (user_rating === undefined && estimated_hours_saved === undefined && business_value_note === undefined) {
    return NextResponse.json(
      { error: 'At least one of user_rating, estimated_hours_saved, or business_value_note is required' },
      { status: 400 },
    )
  }

  // ─── Persist ───────────────────────────────────────────────────────────────
  const updateData: Record<string, unknown> = {}
  if (user_rating          !== undefined) updateData.user_rating           = user_rating as number
  if (estimated_hours_saved !== undefined) updateData.estimated_hours_saved = estimated_hours_saved as number
  if (business_value_note  !== undefined) updateData.business_value_note   = business_value_note as string

  await db.run.update({
    where: { id: runId },
    data:  updateData,
  })

  return NextResponse.json({ ok: true, run_id: runId })
}
