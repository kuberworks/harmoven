// app/api/admin/rgpd/route.ts
// GET  /api/admin/rgpd — Read RGPD maintenance settings
// PATCH /api/admin/rgpd — Update RGPD maintenance settings
//
// Required role: instance_admin.
//
// Settings stored in SystemSetting (DB):
//   rgpd.maintenance_enabled  → bool  controls session-cleanup + run-data-TTL crons
//   rgpd.data_retention_days  → int   days before Run content is nullified
//
// Env var RGPD_MAINTENANCE_ENABLED=false takes precedence over DB and is surfaced
// as `env_override_active: true` so the UI can display a warning.
//
// Note: user-facing rights (DELETE /api/users/me, GET /api/users/me/data)
// are NOT controlled here — they are statutory rights (Art.17, Art.20) and
// must always remain active.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { getRgpdConfig, RGPD_KEYS }  from '@/lib/maintenance/rgpd-config'
import { uuidv7 }                    from '@/lib/utils/uuidv7'

const PatchSchema = z.object({
  maintenance_enabled:  z.boolean().optional(),
  data_retention_days:  z.number().int().min(7).max(3650).optional(),
}).strict()

async function requireAdmin(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) throw new UnauthorizedError('Unauthorized')
  assertInstanceAdmin(caller)
  return caller
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(req)
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  const config = await getRgpdConfig()
  return NextResponse.json(config)
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  let caller: Awaited<ReturnType<typeof requireAdmin>>
  try {
    caller = await requireAdmin(req)
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  let body: z.infer<typeof PatchSchema>
  const rawBody = await req.json().catch(() => null)
  const parseResult = PatchSchema.safeParse(rawBody)
  if (!parseResult.success) {
    return NextResponse.json({ error: parseResult.error.flatten() }, { status: 400 })
  }
  body = parseResult.data

  const actorId = caller.type === 'session' ? caller.userId : undefined

  if (body.maintenance_enabled !== undefined) {
    await db.systemSetting.upsert({
      where:  { key: RGPD_KEYS.maintenanceEnabled },
      create: { key: RGPD_KEYS.maintenanceEnabled, value: String(body.maintenance_enabled), updated_by: actorId },
      update: { value: String(body.maintenance_enabled), updated_by: actorId },
    })
  }

  if (body.data_retention_days !== undefined) {
    await db.systemSetting.upsert({
      where:  { key: RGPD_KEYS.dataRetentionDays },
      create: { key: RGPD_KEYS.dataRetentionDays, value: String(body.data_retention_days), updated_by: actorId },
      update: { value: String(body.data_retention_days), updated_by: actorId },
    })
  }

  // Audit trail
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId ?? 'system',
      action_type: 'admin.rgpd.config.updated',
      payload:     body,
    },
  })

  const updated = await getRgpdConfig()
  return NextResponse.json(updated)
}
