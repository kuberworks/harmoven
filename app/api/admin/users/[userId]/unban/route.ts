// app/api/admin/users/[userId]/unban/route.ts
// Admin — unban a user
//
// POST /api/admin/users/:userId/unban
//   Body: {} (no fields required)
//
// Required: instance_admin role.
// Effect: clears banned, banReason, banExpires on the User row.
//   The user can sign in on their next request.

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 }                    from '@/lib/utils/uuidv7'

type Params = { params: Promise<{ userId: string }> }

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

  const target = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, banned: true },
  })
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (!target.banned) {
    return NextResponse.json({ error: 'User is not banned' }, { status: 422 })
  }

  await db.user.update({
    where: { id: userId },
    data:  { banned: false, banReason: null, banExpires: null },
  })

  // AuditLog: unban is a security-critical action — must always be recorded (spec MISS-01).
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'admin.user.unbanned',
      payload:     { target_user_id: userId },
    },
  })

  return NextResponse.json({ ok: true, userId, banned: false })
}
