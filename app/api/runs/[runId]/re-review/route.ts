// app/api/runs/[runId]/re-review/route.ts
// POST /api/runs/:runId/re-review
// Replays a specific node (default: first REVIEWER) on a COMPLETED run.
// Resets the node and any downstream nodes to PENDING, transitions the run
// back to SUSPENDED, and re-enters the execution loop.
//
// Auth: runs:replay permission required.

import { NextRequest, NextResponse }            from 'next/server'
import { z }                                    from 'zod'
import { db }                                   from '@/lib/db/client'
import { resolveCaller }                        from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { getExecutionEngine }                   from '@/lib/execution/engine.factory'
import type { Dag }                             from '@/types/dag.types'

type Params = { params: Promise<{ runId: string }> }

const Body = z.object({
  /** Optional: target a specific node_id. Defaults to the first REVIEWER node. */
  node_id: z.string().min(1).max(128).optional(),
}).strict()

export async function POST(req: NextRequest, { params }: Params) {
  const { runId } = await params

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const run = await db.run.findUnique({
    where:  { id: runId },
    select: { project_id: true, status: true, dag: true },
  })
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, run.project_id)
    await assertRunAccess(runId, run.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, run.project_id)
  if (!perms.has('runs:replay')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Validate run is COMPLETED ────────────────────────────────────────────
  if (run.status !== 'COMPLETED') {
    return NextResponse.json(
      { error: `Run must be COMPLETED to re-run a reviewer (current: ${run.status})` },
      { status: 409 },
    )
  }

  // ─── Parse body ───────────────────────────────────────────────────────────
  let rawBody: unknown
  try {
    rawBody = await req.json().catch(() => ({}))
  } catch {
    rawBody = {}
  }
  const parsed = Body.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  // ─── Resolve target node ──────────────────────────────────────────────────
  const dag = run.dag as unknown as Dag
  let nodeId = parsed.data.node_id

  if (!nodeId) {
    // Default: first REVIEWER node in DAG order
    const reviewerDagNode = dag.nodes.find(n => n.agent_type === 'REVIEWER')
    if (!reviewerDagNode) {
      return NextResponse.json({ error: 'No REVIEWER node found in this run' }, { status: 422 })
    }
    nodeId = reviewerDagNode.id
  } else {
    // Caller supplied a node_id — verify it exists in the DAG
    const dagNode = dag.nodes.find(n => n.id === nodeId)
    if (!dagNode) {
      return NextResponse.json({ error: `Node '${nodeId}' not found in run's DAG` }, { status: 422 })
    }
  }

  // ─── Execute ───────────────────────────────────────────────────────────────
  try {
    const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
    const engine  = await getExecutionEngine()
    await engine.replayNode(runId, nodeId, actorId)
    return NextResponse.json({ ok: true, run_id: runId, node_id: nodeId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) return NextResponse.json({ error: message }, { status: 404 })
    if (message.includes('must be COMPLETED') || message.includes('status')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
