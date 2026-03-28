// app/api/v1/runs/[runId]/route.ts
// GET /api/v1/runs/:runId — Fetch a run and its nodes (public API v1, API key auth).
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
