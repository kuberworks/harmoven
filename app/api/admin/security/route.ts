// app/api/admin/security/route.ts
// GET  /api/admin/security — Read instance security settings
// PATCH /api/admin/security — Update instance security settings
//
// Required: instance_admin role.
// Settings are stored in SystemSetting (DB) and consulted by the middleware
// via /api/instance/policy (public, cached).
//
// Env vars ALWAYS take precedence over DB values:
//   HARMOVEN_ENFORCE_ADMIN_MFA=false + HARMOVEN_MFA_DISABLE_ACKNOWLEDGED=...
//   overrides whatever is stored here (operator escape hatch).

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 }                    from '@/lib/utils/uuidv7'

// Keys exposed through this endpoint (allowlist — never expose internal keys)
const SECURITY_KEYS = ['security.mfa_required_for_admin'] as const
type SecurityKey = (typeof SECURITY_KEYS)[number]

const PatchSchema = z.object({
  mfa_required_for_admin: z.boolean().optional(),
})

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

  const rows = await db.systemSetting.findMany({
    where: { key: { in: SECURITY_KEYS as unknown as string[] } },
  })

  const settings: Record<string, unknown> = {}
  for (const row of rows) {
    try { settings[row.key] = JSON.parse(row.value) } catch { settings[row.key] = row.value }
  }

  // Env var overrides — surface them so the frontend can warn the user
  const envOverride = process.env.HARMOVEN_ENFORCE_ADMIN_MFA === 'false'
    && process.env.HARMOVEN_MFA_DISABLE_ACKNOWLEDGED === 'I_UNDERSTAND_THE_SECURITY_RISK'

  return NextResponse.json({
    mfa_required_for_admin: settings['security.mfa_required_for_admin'] ?? true,
    env_override_active: envOverride,  // true = env var is forcing MFA off regardless of DB
  })
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

  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })
  }

  const { mfa_required_for_admin } = parsed.data

  if (mfa_required_for_admin !== undefined) {
    const userId = caller.type === 'session' ? caller.userId : undefined
    await db.systemSetting.upsert({
      where:  { key: 'security.mfa_required_for_admin' },
      create: { key: 'security.mfa_required_for_admin', value: JSON.stringify(mfa_required_for_admin), updated_by: userId },
      update: { value: JSON.stringify(mfa_required_for_admin), updated_by: userId },
    })

    // AuditLog: security setting changes are critical — must always be recorded (spec MISS-01).
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       userId ?? 'system',
        action_type: 'admin.security.updated',
        payload:     { mfa_required_for_admin },
      },
    })
  }

  return NextResponse.json({ ok: true })
}
