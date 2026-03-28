// app/api/runs/[runId]/gate/route.ts
// POST /api/runs/:runId/gate
// Resolve the human gate for a run. Decisions: approve | modify | replay_node | abort.
//
// Auth: gates:approve permission required.
// - approve     → engine.resumeRun (run must be SUSPENDED or PAUSED)
// - abort       → engine.cancelRun
// - modify      → merge task_input patch, then engine.resumeRun
// - replay_node → engine.resolveInterruptGate on the specified node (replay_from_scratch)

import { NextRequest, NextResponse }            from 'next/server'
import { z }                                    from 'zod'
import { Prisma }                               from '@prisma/client'
import { db }                                   from '@/lib/db/client'
import { resolveCaller }                        from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { getExecutionEngine }                   from '@/lib/execution/engine.factory'

type Params = { params: Promise<{ runId: string }> }

const GateBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('abort')   }).strict(),
  z.object({
    decision: z.literal('replay_node'),
    node_id:  z.string().min(1),
    patch:    z.record(z.unknown()).optional(),
  }).strict(),
  z.object({
    decision: z.literal('modify'),
    patch:    z.record(z.unknown()),
  }).strict(),
])

export async function POST(req: NextRequest, { params }: Params) {
  const { runId } = await params

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const runLookup = await db.run.findUnique({
    where:  { id: runId },
    select: { project_id: true, status: true, task_input: true },
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
  // Spec: gates:write permission is the entry guard (any gate action requires it).
  // Individual decisions (approve/modify/replay/abort) are further restricted
  // at the business logic layer if needed.
  if (!perms.has('gates:write')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Parse body ───────────────────────────────────────────────────────────
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = GateBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const body = parsed.data
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  // ─── Dispatch ─────────────────────────────────────────────────────────────
  try {
    const engine = await getExecutionEngine()
    let newStatus: string

    switch (body.decision) {
      case 'approve': {
        await engine.resumeRun(runId, actorId)
        newStatus = 'running'
        break
      }

      case 'abort': {
        await engine.cancelRun(runId, actorId)
        newStatus = 'failed'
        break
      }

      case 'modify': {
        // Merge patch into existing task_input, then resume
        const existing = (runLookup.task_input ?? {}) as Record<string, unknown>
        const merged   = { ...existing, ...body.patch }
        await db.run.update({ where: { id: runId }, data: { task_input: merged as Prisma.InputJsonValue } })
        await db.auditLog.create({
          data: {
            actor:       actorId,
            action_type: 'gate:modify',
            payload: {
              run_id:    runId,
              input_was: existing as Prisma.InputJsonValue,
              input_now: merged   as Prisma.InputJsonValue,
            },
          },
        })
        await engine.resumeRun(runId, actorId)
        newStatus = 'running'
        break
      }

      case 'replay_node': {
        await engine.resolveInterruptGate(runId, body.node_id, actorId, {
          decision: 'replay_from_scratch',
        })
        newStatus = 'running'
        break
      }
    }

    return NextResponse.json({ ok: true, run_id: runId, status: newStatus! })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('not found')) return NextResponse.json({ error: message }, { status: 404 })
    if (message.includes('status') || message.includes('transition') || message.includes('not SUSPENDED') || message.includes('not PAUSED')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
