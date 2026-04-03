// app/api/projects/[id]/roles/[roleId]/route.ts
// PATCH  /api/projects/:id/roles/:roleId  — Update a custom role
// DELETE /api/projects/:id/roles/:roleId  — Delete a custom role
//
// Auth: project:members required.
// Constraints: built-in roles cannot be modified or deleted.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import {
  resolvePermissions,
  invalidateProjectPermCache,
} from '@/lib/auth/rbac'
import type { SessionCaller, Caller } from '@/lib/auth/rbac'
import { ALL_PERMISSIONS } from '@/lib/auth/permissions'
import type { Permission } from '@/lib/auth/permissions'
import { uuidv7 } from '@/lib/utils/uuidv7'

type Params = { params: Promise<{ id: string; roleId: string }> }

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS)
const BUILTIN_ROLE_NAMES = new Set([
  'viewer', 'operator', 'user', 'user_with_costs', 'developer', 'admin', 'instance_admin',
])

type RoleRow = { id: string; project_id: string | null; is_builtin: boolean; name: string }
type GuardRoleResult =
  | { code: 'ok'; caller: Caller; role: RoleRow }
  | { code: 'unauthorized' | 'forbidden' | 'builtin' }

async function guardAndFetchRole(req: NextRequest, projectId: string, roleId: string): Promise<GuardRoleResult> {
  const caller = await resolveCaller(req)
  if (!caller) return { code: 'unauthorized' }
  try {
    await assertProjectAccess(caller, projectId)
  } catch {
    return { code: 'forbidden' }
  }
  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:members')) return { code: 'forbidden' }

  const role = await db.projectRole.findUnique({
    where: { id: roleId },
    select: { id: true, project_id: true, is_builtin: true, name: true },
  })
  if (!role || role.project_id !== projectId) return { code: 'forbidden' }
  if (role.is_builtin) return { code: 'builtin' }

  return { code: 'ok', caller, role }
}

interface UpdateRoleBody {
  display_name?: string
  extends?:     string | null
  permissions?: string[]
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id: projectId, roleId } = await params

  const guard = await guardAndFetchRole(req, projectId, roleId)
  if (guard.code !== 'ok') {
    if (guard.code === 'unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (guard.code === 'builtin') return NextResponse.json({ error: 'Built-in roles cannot be modified' }, { status: 400 })
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { caller, role } = guard

  let body: UpdateRoleBody
  try {
    body = await req.json() as UpdateRoleBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { display_name, extends: extendsRole, permissions } = body

  if (display_name !== undefined && (typeof display_name !== 'string' || display_name.length > 128)) {
    return NextResponse.json({ error: 'display_name must be a string ≤128 chars' }, { status: 400 })
  }
  if (extendsRole !== undefined && extendsRole !== null && !BUILTIN_ROLE_NAMES.has(extendsRole)) {
    return NextResponse.json({ error: 'extends must be a built-in role name or null' }, { status: 400 })
  }
  if (permissions !== undefined) {
    const invalid = permissions.filter((p) => !VALID_PERMISSIONS.has(p))
    if (invalid.length > 0) {
      return NextResponse.json({ error: `Unknown permissions: ${invalid.join(', ')}` }, { status: 400 })
    }
  }

  const updateData: {
    display_name?: string
    extends?: string | null
    permissions?: Permission[]
  } = {}
  if (display_name !== undefined) updateData.display_name = display_name
  if (extendsRole  !== undefined) updateData.extends      = extendsRole
  if (permissions  !== undefined) updateData.permissions  = permissions.filter(
    (p): p is Permission => VALID_PERMISSIONS.has(p),
  )

  const updated = await db.projectRole.update({
    where: { id: roleId },
    data:  updateData,
    select: {
      id: true, name: true, display_name: true,
      extends: true, permissions: true, is_builtin: true,
    },
  })

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'project_role_updated',
      payload:     { project_id: projectId, role_id: roleId, role_name: role.name },
    },
  })

  // Role definition changed — invalidate all cached permissions for this project
  // since every member holding this role has a stale permission set.
  invalidateProjectPermCache(projectId)

  return NextResponse.json({ role: updated })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id: projectId, roleId } = await params

  const guard = await guardAndFetchRole(req, projectId, roleId)
  if (guard.code !== 'ok') {
    if (guard.code === 'unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (guard.code === 'builtin') return NextResponse.json({ error: 'Built-in roles cannot be deleted' }, { status: 400 })
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { caller, role } = guard

  // Reject if any member or API key still uses this role
  const memberCount  = await db.projectMember.count({ where: { role_id: roleId } })
  const apiKeyCount  = await db.projectApiKey.count({ where: { role_id: roleId } })
  if (memberCount + apiKeyCount > 0) {
    return NextResponse.json(
      { error: 'Role is in use — reassign members and API keys before deleting' },
      { status: 409 },
    )
  }

  await db.projectRole.delete({ where: { id: roleId } })

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'project_role_deleted',
      payload:     { project_id: projectId, role_id: roleId, role_name: role.name },
    },
  })

  return new NextResponse(null, { status: 204 })
}
