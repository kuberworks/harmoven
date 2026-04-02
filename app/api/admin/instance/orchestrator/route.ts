// app/api/admin/instance/orchestrator/route.ts
// GET  /api/admin/instance/orchestrator — read orchestrator.yaml fields
// PATCH /api/admin/instance/orchestrator — update allowed fields, validate coherence
//
// Required: instance_admin role.

import { NextRequest, NextResponse } from 'next/server'

import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 }                    from '@/lib/utils/uuidv7'
import {
  readOrchestratorYaml,
  patchOrchestratorYaml,
  OrchestratorPatchSchema,
} from '@/lib/config-git/orchestrator-config'

async function requireAdmin(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) throw new UnauthorizedError('Unauthorized')
  assertInstanceAdmin(caller)
  return caller
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req)
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  const config = await readOrchestratorYaml()
  return NextResponse.json(config)
}

export async function PATCH(req: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireAdmin>>
  try {
    caller = await requireAdmin(req)
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = OrchestratorPatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    )
  }

  try {
    const { warnings } = await patchOrchestratorYaml(parsed.data, caller.userId)

    // AuditLog: orchestrator.yaml changes affect critical system behaviour
    // (full_auto mode, execution engine, opt-in services) — must always be
    // recorded (spec MISS-01 / same policy as admin.security.updated).
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'admin.orchestrator.updated',
        payload:     parsed.data,
      },
    })

    return NextResponse.json({ ok: true, warnings })
  } catch (e) {
    console.error('[PATCH /api/admin/instance/orchestrator]', e)
    return NextResponse.json({ error: 'Failed to write orchestrator.yaml' }, { status: 500 })
  }
}
