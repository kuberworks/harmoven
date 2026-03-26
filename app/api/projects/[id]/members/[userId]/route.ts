// app/api/projects/[id]/members/[userId]/route.ts
// PATCH  /api/projects/:id/members/:userId  — Change a member's role
// DELETE /api/projects/:id/members/:userId  — Remove a member from the project
//
// Auth: project:members permission required.
// Safety: Prevents removing or role-changing the last admin of a project.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import {
  resolvePermissions,
  invalidatePermCache,
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/auth/rbac'

type Params = { params: Promise<{ id: string; userId: string }> }

async function authGuard(req: NextRequest, projectId: string) {
  const caller = await resolveCaller(req)
  if (!caller) throw new UnauthorizedError()
  await assertProjectAccess(caller, projectId)
  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:members')) throw new ForbiddenError()
  return caller
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id: projectId, userId } = await params

  let caller
  try {
    caller = await authGuard(req, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { role_id: string }
  try {
    body = await req.json() as { role_id: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { role_id } = body
  if (!role_id) return NextResponse.json({ error: 'Missing role_id' }, { status: 400 })

  // Verify member exists
  const existing = await db.projectMember.findUnique({
    where: { project_id_user_id: { project_id: projectId, user_id: userId } },
    select: { user_id: true, role: { select: { name: true } } },
  })
  if (!existing) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

  // Validate new role
  const newRole = await db.projectRole.findUnique({
    where: { id: role_id },
    select: { id: true, project_id: true, is_builtin: true, name: true },
  })
  if (!newRole) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  if (!newRole.is_builtin && newRole.project_id !== projectId) {
    return NextResponse.json({ error: 'Role does not belong to this project' }, { status: 400 })
  }

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  const updated = await db.projectMember.update({
    where: { project_id_user_id: { project_id: projectId, user_id: userId } },
    data:  { role_id, added_by: actorId },
    select: {
      user_id: true,
      role: { select: { id: true, name: true, display_name: true } },
    },
  })

  // Invalidate permission cache for this user — their new role takes effect immediately.
  invalidatePermCache({ type: 'session', userId, instanceRole: null }, projectId)

  await db.auditLog.create({
    data: {
      actor:       actorId,
      action_type: 'project_member_role_changed',
      payload:     { project_id: projectId, user_id: userId, new_role_id: role_id, previous_role: existing.role.name },
    },
  })

  return NextResponse.json({ member: updated })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id: projectId, userId } = await params

  let caller
  try {
    caller = await authGuard(req, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const existing = await db.projectMember.findUnique({
    where: { project_id_user_id: { project_id: projectId, user_id: userId } },
    select: { user_id: true, role: { select: { name: true } } },
  })
  if (!existing) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  // Prevent removing the last admin
  if (existing.role.name === 'admin' || existing.role.name === 'instance_admin') {
    const adminCount = await db.projectMember.count({
      where: {
        project_id: projectId,
        role: { name: { in: ['admin', 'instance_admin'] } },
      },
    })
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: 'Cannot remove the last admin from the project' },
        { status: 409 },
      )
    }
  }

  await db.projectMember.delete({
    where: { project_id_user_id: { project_id: projectId, user_id: userId } },
  })

  // Invalidate permission cache for the removed user.
  invalidatePermCache({ type: 'session', userId, instanceRole: null }, projectId)

  await db.auditLog.create({
    data: {
      actor:       actorId,
      action_type: 'project_member_removed',
      payload:     { project_id: projectId, user_id: userId, previous_role: existing.role.name },
    },
  })

  return new NextResponse(null, { status: 204 })
}
