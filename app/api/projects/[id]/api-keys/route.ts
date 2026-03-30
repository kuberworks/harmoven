// app/api/projects/[id]/api-keys/route.ts
// GET  /api/projects/:id/api-keys  — List API keys (never returns key_hash or raw key)
// POST /api/projects/:id/api-keys  — Create a new API key (raw key returned ONCE)
//
// Auth: project:credentials required.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/auth/rbac'
import { createProjectApiKey } from '@/lib/auth/project-api-key'
import { checkRateLimitAsync } from '@/lib/auth/rate-limit'
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
  if (!perms.has('project:credentials')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const keys = await db.projectApiKey.findMany({
    where:   { project_id: projectId },
    orderBy: { created_at: 'desc' },
    select: {
      id:         true,
      name:       true,
      created_at: true,
      created_by: true,
      last_used:  true,
      expires_at: true,
      revoked_at: true,
      role: { select: { id: true, name: true, display_name: true } },
      // key_hash deliberately excluded — never expose even the hash
    },
  })

  return NextResponse.json({ keys })
}

interface CreateKeyBody {
  name:       string
  role_id:    string
  expires_at?: string // ISO 8601 or omit for no expiry
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  // LOW-3: prevent brute-force API key creation (10 per 15 min per IP)
  const rl = await checkRateLimitAsync(req, 'create-api-key', 10, 15 * 60 * 1000)
  if (rl) return rl

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
  if (!perms.has('project:credentials')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: CreateKeyBody
  try {
    body = await req.json() as CreateKeyBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { name, role_id, expires_at: expiresAtStr } = body

  if (!name || typeof name !== 'string' || name.length > 128) {
    return NextResponse.json({ error: 'name is required (≤128 chars)' }, { status: 400 })
  }
  if (!role_id) {
    return NextResponse.json({ error: 'role_id is required' }, { status: 400 })
  }

  // Validate role — must be built-in or project-scoped
  const role = await db.projectRole.findUnique({
    where: { id: role_id },
    select: { id: true, project_id: true, is_builtin: true, name: true },
  })
  if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  if (!role.is_builtin && role.project_id !== projectId) {
    return NextResponse.json({ error: 'Role does not belong to this project' }, { status: 400 })
  }
  // Security: API keys must never carry instance_admin privileges.
  // instance_admin bypasses all project membership checks — that scope
  // must be reserved for human sessions only.
  if (role.name === 'instance_admin') {
    return NextResponse.json({ error: 'API keys cannot be assigned the instance_admin role' }, { status: 400 })
  }

  // Parse optional expiry — reject invalid date strings
  let expiresAt: Date | undefined
  if (expiresAtStr) {
    const parsed = new Date(expiresAtStr)
    if (isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'expires_at must be a valid ISO 8601 date' }, { status: 400 })
    }
    if (parsed <= new Date()) {
      return NextResponse.json({ error: 'expires_at must be in the future' }, { status: 400 })
    }
    expiresAt = parsed
  }

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  const result = await createProjectApiKey({
    projectId,
    roleId:    role_id,
    name,
    createdBy: actorId,
    expiresAt,
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'api_key_created',
      payload:     { project_id: projectId, key_id: result.id, name, role_name: role.name },
    },
  })

  // rawKey is returned ONCE in the response — never log or store it
  return NextResponse.json(
    {
      key: {
        id:         result.id,
        name:       result.name,
        raw_key:    result.rawKey,
        created_at: result.createdAt,
        expires_at: result.expiresAt,
        role:       { id: role.id, name: role.name },
      },
    },
    { status: 201 },
  )
}
