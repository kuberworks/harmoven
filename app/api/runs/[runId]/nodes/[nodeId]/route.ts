// app/api/runs/[runId]/nodes/[nodeId]/route.ts
// GET /api/runs/:runId/nodes/:nodeId — Node detail + its handoffs.
// Spec: TECHNICAL.md L.704, L.56 (directory listing).
//
// Security:
//   - Requires runs:read permission on the parent project.
//   - assertProjectAccess + assertRunAccess guard IDOR.
//   - Cost fields (cost_usd, tokens_*) redacted unless caller has runs:read_costs.

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
}                                    from '@/lib/auth/rbac'

type Params = { params: Promise<{ runId: string; nodeId: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { runId, nodeId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Resolve parent run → project (prevents IDOR enumeration)
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

  const node = await db.node.findFirst({
    where: { run_id: runId, node_id: nodeId },
  })
  if (!node) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Handoffs are immutable records — always safe to return.
  const [handoffsIn, handoffsOut] = await Promise.all([
    db.handoff.findMany({
      where:   { run_id: runId, target_agent: node.agent_type },
      orderBy: { sequence_number: 'asc' },
      select:  { id: true, sequence_number: true, source_agent: true, target_agent: true, payload: true, created_at: true },
    }),
    db.handoff.findMany({
      where:   { run_id: runId, source_agent: node.agent_type, source_node_id: nodeId },
      orderBy: { sequence_number: 'asc' },
      select:  { id: true, sequence_number: true, source_agent: true, target_agent: true, payload: true, created_at: true },
    }),
  ])

  // Redact cost fields unless caller has runs:read_costs permission.
  const safeNode = hasCosts
    ? node
    : { ...node, cost_usd: undefined, tokens_in: undefined, tokens_out: undefined }

  return NextResponse.json({ node: safeNode, handoffs_in: handoffsIn, handoffs_out: handoffsOut })
}
