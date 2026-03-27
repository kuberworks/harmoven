// app/api/admin/users/[userId]/ban/route.ts
// Admin — ban a user
//
// POST /api/admin/users/:userId/ban
//   Body: { reason?: string; expires_at?: ISO8601 }
//
// Required: instance_admin role.
// Effect: sets banned=true + banReason + banExpires on the User row, then
//   deletes all active sessions so the ban takes effect immediately
//   (session.cookieCache is disabled — no stale-session window).
//
// SECURITY: an instance_admin cannot ban themselves.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'

type Params = { params: Promise<{ userId: string }> }

const BanBody = z.object({
  reason:     z.string().max(512).optional(),
  expires_at: z.string().datetime().optional(), // ISO-8601; omit for permanent ban
}).strict()

export async function POST(req: NextRequest, { params }: Params) {
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

  const { userId } = await params

  // SECURITY: prevent self-ban
  if (userId === caller.userId) {
    return NextResponse.json({ error: 'Cannot ban yourself' }, { status: 422 })
  }

  const target = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, banned: true },
  })
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json().catch(() => ({}))
  } catch {
    body = {}
  }

  const parsed = BanBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { reason, expires_at } = parsed.data

  // Update user + delete their active sessions atomically
  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data:  {
        banned:    true,
        banReason: reason     ?? null,
        banExpires: expires_at ? new Date(expires_at) : null,
      },
    }),
    db.session.deleteMany({ where: { userId } }),
  ])

  return NextResponse.json({ ok: true, userId, banned: true })
}
