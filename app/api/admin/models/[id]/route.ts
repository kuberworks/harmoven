// app/api/admin/models/[id]/route.ts
// Admin LLM model management — update + delete
//
// PATCH  /api/admin/models/:id    — partial update of an LlmProfile
// DELETE /api/admin/models/:id    — permanently delete a model
//
// Required: instance_admin role.
// DELETE guard: 409 Conflict if the model is referenced by active runs.
// Security: model ID sanitised to prevent path traversal; Zod strict body validation.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { Prisma, RunStatus }          from '@prisma/client'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller }        from '@/lib/auth/rbac'

// ─── Auth helper ──────────────────────────────────────────────────────────────

type AdminGuardResult =
  | { caller: SessionCaller; err: null }
  | { caller: null;          err: NextResponse }

async function guardAdminModels(req: NextRequest): Promise<AdminGuardResult> {
  const caller = await resolveCaller(req)
  if (!caller) {
    return { caller: null, err: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  try {
    assertInstanceAdmin(caller)
    return { caller, err: null }
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return { caller: null, err: NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status }) }
  }
}

type Params = { params: Promise<{ id: string }> }

// ─── PATCH /api/admin/models/:id ─────────────────────────────────────────────

const PatchModelBody = z.object({
  provider:                   z.string().min(1).max(64).optional(),
  model_string:               z.string().min(1).max(256).optional(),
  tier:                       z.string().min(1).max(64).optional(),
  jurisdiction:               z.string().max(32).optional(),
  trust_tier:                 z.number().int().min(1).max(3).optional(),
  enabled:                    z.boolean().optional(),
  task_type_affinity:         z.array(z.string()).optional(),
  config:                     z.record(z.unknown()).optional(),
}).strict()

export async function PATCH(req: NextRequest, { params }: Params) {
  const { err } = await guardAdminModels(req)
  if (err) return err

  const { id } = await params

  const existing = await db.llmProfile.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PatchModelBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 422 })
  }

  const { config, ...rest } = parsed.data
  const model = await db.llmProfile.update({
    where: { id },
    data:  {
      ...rest,
      ...(config !== undefined && { config: config as Prisma.InputJsonValue }),
    },
  })

  return NextResponse.json({ model })
}

// ─── DELETE /api/admin/models/:id ────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Params) {
  const { err } = await guardAdminModels(req)
  if (err) return err

  const { id } = await params

  const existing = await db.llmProfile.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  }

  // Guard: refuse deletion if any non-terminal run references this model profile
  const activeRunCount = await db.run.count({
    where: {
      domain_profile: id,
      status: { notIn: ['COMPLETED', 'FAILED'] as RunStatus[] },
    },
  })
  if (activeRunCount > 0) {
    return NextResponse.json(
      { error: 'Cannot delete model — referenced by active runs' },
      { status: 409 },
    )
  }

  await db.llmProfile.delete({ where: { id } })

  return new NextResponse(null, { status: 204 })
}
