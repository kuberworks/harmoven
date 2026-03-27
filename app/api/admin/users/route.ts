// app/api/admin/users/route.ts
// Admin user management — list users
//
// GET /api/admin/users  — list all users (optional ?role= ?banned= filters + ?page ?limit pagination)
//
// Required: instance_admin role.
// SECURITY: sensitive fields (hashed passwords are not in User model; no exposure risk).
//   API keys are in a separate table and are NOT returned here.

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    assertInstanceAdmin(caller)
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  const url    = new URL(req.url)
  const role   = url.searchParams.get('role')   ?? undefined
  const banned = url.searchParams.get('banned')
  const page   = Math.max(1, parseInt(url.searchParams.get('page')  ?? '1', 10))
  const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)))

  const where: Record<string, unknown> = {}
  if (role)              where['role']   = role
  if (banned === 'true') where['banned'] = true
  if (banned === 'false') where['banned'] = { not: true }

  const [users, total] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id:            true,
        name:          true,
        email:         true,
        emailVerified: true,
        image:         true,
        createdAt:     true,
        updatedAt:     true,
        role:          true,
        banned:        true,
        banReason:     true,
        banExpires:    true,
        ui_locale:     true,
      },
      orderBy: { createdAt: 'desc' },
      skip:  (page - 1) * limit,
      take:  limit,
    }),
    db.user.count({ where }),
  ])

  return NextResponse.json({
    users,
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  })
}
