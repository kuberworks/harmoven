// app/api/admin/users/[userId]/route.ts
// Admin — update a user (role change)
//
// PATCH /api/admin/users/:userId
//   Body: { role: 'user' | 'instance_admin' }
//
// Required: instance_admin role.
// Safety guards:
//   - Cannot change your own role (to prevent self-demotion lockout)
//   - Cannot demote the last instance_admin (would lock the instance)

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 }                    from '@/lib/utils/uuidv7'

type Params = { params: Promise<{ userId: string }> }

const PatchUserBody = z.object({
  role: z.enum(['user', 'instance_admin']),
}).strict()

export async function PATCH(req: NextRequest, { params }: Params) {
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

  // SECURITY: prevent self-role-change (could accidentally lock out caller)
  if (userId === caller.userId) {
    return NextResponse.json({ error: 'Cannot change your own role' }, { status: 422 })
  }

  const target = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, role: true },
  })
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  let body: unknown
  try { body = await req.json() } catch { body = {} }

  const parsed = PatchUserBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { role } = parsed.data

  // SAFETY: guard against demoting the last instance_admin
  if (target.role === 'instance_admin' && role !== 'instance_admin') {
    const adminCount = await db.user.count({ where: { role: 'instance_admin' } })
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: 'Cannot demote the last instance_admin — promote another user first' },
        { status: 422 },
      )
    }
  }

  const previousRole = target.role

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data:  { role, updatedAt: new Date() },
    }),
    db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'admin.user.role_changed',
        payload:     { target_user_id: userId, previous_role: previousRole, new_role: role },
      },
    }),
  ])

  return NextResponse.json({ ok: true, userId, role })
}

// ─── DELETE /api/admin/users/:userId — delete user ───────────────────────────

export async function DELETE(req: NextRequest, { params }: Params) {
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

  // SECURITY: cannot delete yourself
  if (userId === caller.userId) {
    return NextResponse.json({ error: 'Cannot delete your own account' }, { status: 422 })
  }

  const target = await db.user.findUnique({
    where:  { id: userId },
    select: { id: true, role: true, email: true },
  })
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // SAFETY: cannot delete the last instance_admin
  if (target.role === 'instance_admin') {
    const adminCount = await db.user.count({ where: { role: 'instance_admin' } })
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: 'Cannot delete the last instance_admin — promote another user first' },
        { status: 422 },
      )
    }
  }

  // Cascade deletion: better-auth schema has `onDelete: Cascade` on Session, Account, Passkey, etc.
  // Deleting the User row is sufficient to remove all dependent records.
  await db.$transaction([
    db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'admin.user.deleted',
        payload:     { target_user_id: userId, email: target.email },
      },
    }),
    db.user.delete({ where: { id: userId } }),
  ])

  return NextResponse.json({ ok: true, userId })
}
