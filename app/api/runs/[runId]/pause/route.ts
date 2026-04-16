// app/api/runs/[runId]/pause/route.ts
// POST /api/runs/:runId/pause
// Pause a RUNNING run — in-flight nodes finish, no new nodes start.
// Amendment 63.
//
// Auth: runs:pause permission required.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { getExecutionEngine } from '@/lib/execution/engine.factory'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
  if (!perms.has('runs:pause')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Pause ────────────────────────────────────────────────────────────────
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  try {
    const engine = await getExecutionEngine()
    await engine.pauseRun(runId, actorId)
    return NextResponse.json({ ok: true, run_id: runId, status: 'PAUSED' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('Invalid transition') || message.includes('Cannot')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
