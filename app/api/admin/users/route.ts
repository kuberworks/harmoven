// app/api/admin/users/route.ts
// Admin user management — list and create users
//
// GET  /api/admin/users  — list all users (optional ?role= ?banned= filters + ?page ?limit pagination)
// POST /api/admin/users  — create a new user account (name, email, password, optional role)
//
// Required: instance_admin role.
// SECURITY: sensitive fields (hashed passwords are not in User model; no exposure risk).
//   API keys are in a separate table and are NOT returned here.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { hashPassword }              from 'better-auth/crypto'
import { uuidv7 }                    from '@/lib/utils/uuidv7'

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

// ─── POST /api/admin/users — create user ─────────────────────────────────────

const CreateUserBody = z.object({
  name:     z.string().min(1).max(256).trim(),
  email:    z.string().email().max(512).toLowerCase(),
  password: z.string().min(8).max(128),
  role:     z.enum(['user', 'instance_admin']).default('user'),
}).strict()

export async function POST(req: NextRequest) {
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

  let body: unknown
  try { body = await req.json() } catch { body = {} }

  const parsed = CreateUserBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { name, email, password, role } = parsed.data

  // Reject duplicate email
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (existing) {
    return NextResponse.json({ error: 'Email already registered' }, { status: 409 })
  }

  const passwordHash = await hashPassword(password)
  const now = new Date()
  const userId = uuidv7()

  // Create User + credential Account atomically
  await db.$transaction([
    db.user.create({
      data: {
        id:            userId,
        name,
        email,
        role,
        // Admin-created accounts are considered verified (admin vouch)
        emailVerified: true,
        createdAt:     now,
        updatedAt:     now,
      },
    }),
    // better-auth credential account — providerId='credential', accountId=email
    db.account.create({
      data: {
        id:         uuidv7(),
        userId,
        accountId:  email,
        providerId: 'credential',
        password:   passwordHash,
        createdAt:  now,
        updatedAt:  now,
      },
    }),
    db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'admin.user.created',
        payload:     { target_user_id: userId, email, role },
      },
    }),
  ])

  return NextResponse.json({ ok: true, userId }, { status: 201 })
}
