// app/api/runs/[runId]/nodes/[nodeId]/gate/route.ts
// POST /api/runs/:runId/nodes/:nodeId/gate
// Resolve an Interrupt Gate for an INTERRUPTED node.
// Three decisions: resume_from_partial | replay_from_scratch | accept_partial
// Amendment 65.
//
// Auth: gates:approve permission required.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { getExecutionEngine } from '@/lib/execution/engine.factory'
import type { GateDecision } from '@/lib/execution/engine.interface'

// ─── Zod schema ─────────────────────────────────────────────────────────────
const GateBodySchema = z.discriminatedUnion('decision', [
  z.object({
    decision:       z.literal('resume_from_partial'),
    edited_partial: z.string().min(1).max(100_000),  // cap partial output size
  }).strict(),
  z.object({ decision: z.literal('replay_from_scratch') }).strict(),
  z.object({ decision: z.literal('accept_partial')     }).strict(),
])

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
  if (!perms.has('gates:approve')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Validate body (C-02: Zod discriminatedUnion) ───────────────────────
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const gateResult = GateBodySchema.safeParse(rawBody)
  if (!gateResult.success) {
    return NextResponse.json({ error: gateResult.error.flatten() }, { status: 422 })
  }
  const body = gateResult.data as GateDecision

  // ─── Resolve gate ─────────────────────────────────────────────────────────
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  try {
    const engine = await getExecutionEngine()
    await engine.resolveInterruptGate(runId, nodeId, actorId, body)
    return NextResponse.json({ ok: true, run_id: runId, node_id: nodeId, decision: body.decision })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    if (message.includes('not INTERRUPTED') || message.includes('not SUSPENDED') || message.includes('status')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
