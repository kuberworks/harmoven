// app/api/runs/[runId]/fork/route.ts
// POST /api/runs/:runId/fork
// Create a new PENDING run copied from an existing one, with optional patches.
//
// Auth: runs:create permission required.
// The fork is a fully independent run — aborting the source does not affect it.
// Fields copied: project_id, dag, domain_profile, task_input (+ patch), run_config (+ patch),
//   supervision, budget_usd.
// Fields NOT copied: status (→ PENDING), started_at, completed_at, paused_at, cost fields,
//   user_injections, suspended_reason, metadata.

import { NextRequest, NextResponse }            from 'next/server'
import { z }                                    from 'zod'
import { Prisma }                               from '@prisma/client'
import { db }                                   from '@/lib/db/client'
import { resolveCaller }                        from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 }                               from '@/lib/utils/uuidv7'

type Params = { params: Promise<{ runId: string }> }

const ForkBody = z.object({
  task_input_patch: z.record(z.unknown()).optional(),
  run_config_patch: z.record(z.unknown()).optional(),
}).strict()

export async function POST(req: NextRequest, { params }: Params) {
  const { runId } = await params

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const source = await db.run.findUnique({ where: { id: runId } })
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, source.project_id)
    await assertRunAccess(runId, source.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, source.project_id)
  if (!perms.has('runs:create')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Parse body ───────────────────────────────────────────────────────────
  let rawBody: unknown
  try {
    rawBody = (await req.json().catch(() => ({})))
  } catch {
    rawBody = {}
  }

  const parsed = ForkBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { task_input_patch, run_config_patch } = parsed.data

  // ─── Build forked task_input and run_config ────────────────────────────────
  const baseTaskInput  = (source.task_input  ?? {}) as Record<string, unknown>
  const baseRunConfig  = (source.run_config  ?? {}) as Record<string, unknown>

  const forkedTaskInput = task_input_patch
    ? { ...baseTaskInput, ...task_input_patch }
    : baseTaskInput

  const forkedRunConfig = run_config_patch
    ? { ...baseRunConfig, ...run_config_patch }
    : baseRunConfig

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  // ─── Create independent fork ───────────────────────────────────────────────
  const run = await db.run.create({
    data: {
      id:             uuidv7(),     // Spec T1.2: Run IDs must be UUIDv7
      project_id:     source.project_id,
      status:         'PENDING',
      dag:            source.dag as Prisma.InputJsonValue,
      domain_profile: source.domain_profile,
      task_input:     forkedTaskInput as Prisma.InputJsonValue,
      run_config:     forkedRunConfig as Prisma.InputJsonValue,
      budget_usd:     source.budget_usd,
      created_by:     actorId,
      metadata:       { forked_from: runId } as Prisma.InputJsonValue,
    },
  })

  // MISS-01: AuditLog on every write
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'run.forked',
      run_id:      run.id,
      payload:     { forked_from: runId, project_id: source.project_id },
    },
  })

  return NextResponse.json({ run }, { status: 201 })
}
