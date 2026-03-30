// app/api/v1/runs/[runId]/route.ts
// GET    /api/v1/runs/:runId — Fetch a run and its nodes (public API v1, API key auth).
// DELETE /api/v1/runs/:runId — Abort a run (spec TECHNICAL.md L.870).
// MISS-06 (audit gap).

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
}                                    from '@/lib/auth/rbac'
import { getExecutionEngine }        from '@/lib/execution/engine.factory'
import { uuidv7 }                    from '@/lib/utils/uuidv7'

type Params = { params: Promise<{ runId: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { runId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const run = await db.run.findUnique({ where: { id: runId } })
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, run.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, run.project_id)
  if (!perms.has('runs:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const nodes = await db.node.findMany({
    where:   { run_id: runId },
    orderBy: { node_id: 'asc' },
    select: {
      id: true, run_id: true, node_id: true, agent_type: true, status: true,
      cost_usd: true, tokens_in: true, tokens_out: true,
      started_at: true, completed_at: true, error: true,
    },
  })

  return NextResponse.json({ run, nodes })
}

// ─── DELETE — abort ───────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Params) {
  const { runId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const run = await db.run.findUnique({ where: { id: runId }, select: { project_id: true, status: true } })
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, run.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, run.project_id)
  if (!perms.has('runs:abort')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])
  if (TERMINAL.has(run.status as string)) {
    return NextResponse.json({ error: `Run is already in terminal state '${run.status}'` }, { status: 409 })
  }

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  const engine = await getExecutionEngine()
  await engine.cancelRun(runId, actorId)

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      run_id:      runId,
      actor:       actorId,
      action_type: 'run.aborted',
      payload:     { source: 'api_v1' },
    },
  })

  return new NextResponse(null, { status: 204 })
}
