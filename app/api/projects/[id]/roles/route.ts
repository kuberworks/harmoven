// app/api/projects/[id]/roles/route.ts
// GET  /api/projects/:id/roles  — List all roles available for this project
//                                (global built-ins + project-scoped custom)
// POST /api/projects/:id/roles  — Create a custom role for this project
//
// Auth: project:members required for both (role management ⊂ member management).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/auth/rbac'
import { ALL_PERMISSIONS } from '@/lib/auth/permissions'
import type { Permission } from '@/lib/auth/permissions'
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

  const roles = await db.projectRole.findMany({
    where: {
      OR: [
        { is_builtin: true },
        { project_id: projectId },
      ],
    },
    select: {
      id:           true,
      name:         true,
      display_name: true,
      extends:      true,
      permissions:  true,
      is_builtin:   true,
      created_at:   true,
    },
    orderBy: [{ is_builtin: 'desc' }, { created_at: 'asc' }],
  })

  return NextResponse.json({ roles })
}

interface CreateRoleBody {
  name:         string
  display_name: string
  extends?:     string
  permissions:  string[]
}

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS)
const BUILTIN_ROLE_NAMES = new Set([
  'viewer', 'operator', 'user', 'user_with_costs', 'developer', 'admin', 'instance_admin',
])

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

  let body: CreateRoleBody
  try {
    body = await req.json() as CreateRoleBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { name, display_name, extends: extendsRole, permissions = [] } = body

  // Validate name slug: lowercase alphanumeric + underscores only (no injection)
  if (!name || !/^[a-z0-9_]{1,64}$/.test(name)) {
    return NextResponse.json({ error: 'name must match /^[a-z0-9_]{1,64}$/' }, { status: 400 })
  }
  if (!display_name || display_name.length > 128) {
    return NextResponse.json({ error: 'display_name is required (≤128 chars)' }, { status: 400 })
  }

  // Cannot shadow built-in role names with custom roles
  if (BUILTIN_ROLE_NAMES.has(name)) {
    return NextResponse.json({ error: `"${name}" is a reserved built-in role name` }, { status: 409 })
  }

  // Validate that extends points to a known built-in role
  if (extendsRole !== undefined && !BUILTIN_ROLE_NAMES.has(extendsRole)) {
    return NextResponse.json({ error: 'extends must be a built-in role name' }, { status: 400 })
  }

  // Validate and filter permissions — reject any unknown permission string
  const invalidPerms = permissions.filter((p) => !VALID_PERMISSIONS.has(p))
  if (invalidPerms.length > 0) {
    return NextResponse.json(
      { error: `Unknown permissions: ${invalidPerms.join(', ')}` },
      { status: 400 },
    )
  }
  const validatedPermissions = permissions.filter((p): p is Permission =>
    VALID_PERMISSIONS.has(p),
  )

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  let role
  try {
    role = await db.projectRole.create({
      data: {
        project_id:   projectId,
        name,
        display_name,
        extends:      extendsRole ?? null,
        permissions:  validatedPermissions,
        is_builtin:   false,
        created_by:   actorId,
      },
      select: {
        id:           true,
        name:         true,
        display_name: true,
        extends:      true,
        permissions:  true,
        is_builtin:   true,
        created_at:   true,
      },
    })
  } catch (err: unknown) {
    const e = err as { code?: string }
    if (e?.code === 'P2002') {
      return NextResponse.json({ error: 'A role with that name already exists in this project' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'project_role_created',
      payload:     { project_id: projectId, role_id: role.id, name, display_name },
    },
  })

  return NextResponse.json({ role }, { status: 201 })
}
