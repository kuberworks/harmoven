// app/api/projects/[id]/members/route.ts
// GET  /api/projects/:id/members  — List project members + their roles
// POST /api/projects/:id/members  — Add a user to the project
//
// Auth: project:members permission required for both operations.

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
import { uuidv7 } from '@/lib/utils/uuidv7'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:members')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const members = await db.projectMember.findMany({
    where: { project_id: projectId },
    select: {
      user_id:  true,
      added_at: true,
      added_by: true,
      user: { select: { id: true, name: true, email: true } },
      role: { select: { id: true, name: true, display_name: true, is_builtin: true } },
    },
    orderBy: { added_at: 'asc' },
  })

  return NextResponse.json({ members })
}

interface AddMemberBody {
  user_id: string
  role_id: string
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:members')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: AddMemberBody
  try {
    body = await req.json() as AddMemberBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { user_id, role_id } = body
  if (!user_id || !role_id) {
    return NextResponse.json({ error: 'Missing required fields: user_id, role_id' }, { status: 400 })
  }

  // Validate user exists
  const user = await db.user.findUnique({ where: { id: user_id }, select: { id: true } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  // Validate role exists and belongs to this project (or is global built-in)
  const role = await db.projectRole.findUnique({
    where: { id: role_id },
    select: { id: true, project_id: true, is_builtin: true },
  })
  if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  if (!role.is_builtin && role.project_id !== projectId) {
    return NextResponse.json({ error: 'Role does not belong to this project' }, { status: 400 })
  }

  // Upsert: re-use existing row (update role) or create
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  const member = await db.projectMember.upsert({
    where: { project_id_user_id: { project_id: projectId, user_id } },
    create: { project_id: projectId, user_id, role_id, added_by: actorId },
    update: { role_id, added_by: actorId },
    select: {
      user_id: true,
      added_at: true,
      role: { select: { id: true, name: true, display_name: true } },
    },
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'project_member_added',
      payload:     { project_id: projectId, user_id, role_id },
    },
  })

  // Upsert may have changed the member's role — invalidate their cached permissions.
  invalidatePermCache({ type: 'session', userId: user_id, instanceRole: null }, projectId)

  return NextResponse.json({ member }, { status: 201 })
}
