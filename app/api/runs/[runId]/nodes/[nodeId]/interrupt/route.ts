// app/api/runs/[runId]/nodes/[nodeId]/interrupt/route.ts
// POST /api/runs/:runId/nodes/:nodeId/interrupt
// Abort a single in-flight node via its per-node AbortController.
// Sets node → INTERRUPTED, run → SUSPENDED, opens Interrupt Gate.
// Amendment 65.
//
// Auth: runs:abort permission required.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { getExecutionEngine } from '@/lib/execution/engine.factory'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; nodeId: string }> },
) {
  const { runId, nodeId } = await params

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
  if (!perms.has('runs:abort')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Interrupt ────────────────────────────────────────────────────────────
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  try {
    const engine = await getExecutionEngine()
    await engine.interruptNode(runId, nodeId, actorId)
    return NextResponse.json({ ok: true, run_id: runId, node_id: nodeId, status: 'INTERRUPTED' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    if (message.includes('Cannot interrupt') || message.includes('must be RUNNING')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
