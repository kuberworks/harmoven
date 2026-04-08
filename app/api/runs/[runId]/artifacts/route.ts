// app/api/runs/[runId]/artifacts/route.ts
// GET /api/runs/:runId/artifacts
// Lists artifact metadata (no binary data) for all nodes in a run.
// Requires runs:read permission on the run's project.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'

export async function GET(
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
    select: { project_id: true },
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

  // ─── List artifacts (metadata only — no binary data) ──────────────────────
  const includeDiscarded = req.nextUrl.searchParams.get('include_discarded') === 'true'

  // Only instance admins may view discarded artifacts
  if (includeDiscarded && !perms.has('admin:instance')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const artifacts = await db.runArtifact.findMany({
    where:   {
      run_id: runId,
      ...(includeDiscarded ? {} : { artifact_role: { not: 'discarded' } }),
    },
    select:  { id: true, node_id: true, filename: true, mime_type: true, size_bytes: true, created_at: true, artifact_role: true },
    orderBy: { created_at: 'asc' },
  })

  return NextResponse.json(
    artifacts.map(a => ({
      ...a,
      created_at: a.created_at.toISOString(),
    })),
  )
}
