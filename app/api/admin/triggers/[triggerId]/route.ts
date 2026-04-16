// app/api/admin/triggers/[triggerId]/route.ts
// Admin trigger management — update + delete
//
// PATCH  /api/admin/triggers/:triggerId  — partial update (enabled, config, supervision…)
// DELETE /api/admin/triggers/:triggerId  — permanently delete a trigger
//
// Required: instance_admin role.
// DELETE: no active-run guard needed (triggers do not block running jobs).

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { Prisma }                    from '@prisma/client'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller }        from '@/lib/auth/rbac'

// ─── Auth helper ──────────────────────────────────────────────────────────────

type AdminGuardResult =
  | { caller: SessionCaller; err: null }
  | { caller: null;          err: NextResponse }

async function guardAdminTriggers(req: NextRequest): Promise<AdminGuardResult> {
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

type Params = { params: Promise<{ triggerId: string }> }

// ─── PATCH /api/admin/triggers/:triggerId ─────────────────────────────────────

const PatchTriggerBody = z.object({
  name:        z.string().min(1).max(128).optional(),
  config:      z.record(z.unknown()).optional(),
  supervision: z.string().max(64).optional(),
  notify:      z.record(z.unknown()).optional(),
  enabled:     z.boolean().optional(),
}).strict()

export async function PATCH(req: NextRequest, { params }: Params) {
  const { err } = await guardAdminTriggers(req)
  if (err) return err

  const { triggerId } = await params

  const existing = await db.trigger.findUnique({ where: { id: triggerId } })
  if (!existing) {
    return NextResponse.json({ error: 'Trigger not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PatchTriggerBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 422 })
  }

  const { config, notify, ...rest } = parsed.data
  const trigger = await db.trigger.update({
    where: { id: triggerId },
    data:  {
      ...rest,
      ...(config !== undefined && { config: config as Prisma.InputJsonValue }),
      ...(notify !== undefined && { notify: notify as Prisma.InputJsonValue }),
    },
  })

  return NextResponse.json({ trigger })
}

// ─── DELETE /api/admin/triggers/:triggerId ────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Params) {
  const { err } = await guardAdminTriggers(req)
  if (err) return err

  const { triggerId } = await params

  const existing = await db.trigger.findUnique({ where: { id: triggerId } })
  if (!existing) {
    return NextResponse.json({ error: 'Trigger not found' }, { status: 404 })
  }

  await db.trigger.delete({ where: { id: triggerId } })

  return new NextResponse(null, { status: 204 })
}
