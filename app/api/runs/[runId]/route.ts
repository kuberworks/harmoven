// app/api/runs/[runId]/route.ts
// GET /api/runs/:runId  — Fetch a run with its nodes (session or API key auth).
// Spec: getRun (runs:read permission required).

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'

type Params = { params: Promise<{ runId: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { runId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const runLookup = await db.run.findUnique({
    where:  { id: runId },
    select: { project_id: true },
  })
  if (!runLookup) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, runLookup.project_id)
    await assertRunAccess(runId, runLookup.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, runLookup.project_id)
  if (!perms.has('runs:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const hasCosts = perms.has('runs:read_costs')

  const [run, nodes] = await Promise.all([
    db.run.findUnique({ where: { id: runId } }),
    db.node.findMany({ where: { run_id: runId }, orderBy: { node_id: 'asc' } }),
  ])
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Redact cost fields if caller lacks runs:read_costs
  const safeRun = hasCosts
    ? run
    : { ...run, cost_actual_usd: undefined, tokens_actual: undefined }

  const safeNodes = nodes.map(n =>
    hasCosts ? n : { ...n, cost_usd: undefined, tokens_input: undefined, tokens_output: undefined },
  )

  return NextResponse.json({ run: safeRun, nodes: safeNodes })
}
