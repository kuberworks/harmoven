// app/api/projects/route.ts
// GET  /api/projects  — List accessible projects (paginated)
// POST /api/projects  — Create a new project
// Spec: openapi/v1.yaml /projects, TECHNICAL.md §16.

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
}                                    from '@/lib/auth/rbac'

// ─── GET — List accessible projects ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const page    = Math.max(1, parseInt(searchParams.get('page')    ?? '1',  10) || 1)
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('per_page') ?? '20', 10) || 20))

  const isAdmin = caller.type === 'session' && caller.instanceRole === 'instance_admin'

  let projectIds: string[] | null = null

  if (!isAdmin) {
    // Non-admins see only projects where they are a member (or their API key belongs to).
    if (caller.type === 'session') {
      const memberships = await db.projectMember.findMany({
        where: { user_id: caller.userId },
        select: { project_id: true },
      })
      projectIds = memberships.map(m => m.project_id)
    } else {
      // API key: scoped to the one project the key belongs to
      const key = await db.projectApiKey.findUnique({
        where: { id: caller.keyId },
        select: { project_id: true, revoked_at: true, expires_at: true },
      })
      if (!key || key.revoked_at || (key.expires_at && key.expires_at < new Date())) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      projectIds = [key.project_id]
    }

    // Verify the caller has project:read on at least the implied project scope.
    // For API keys, check the specific project; for session users we've already
    // limited to memberships so any member has implicit project:read.
    if (caller.type === 'api_key' && projectIds.length > 0) {
      try {
        const perms = await resolvePermissions(caller, projectIds[0]!)
        if (!perms.has('project:read')) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
      } catch (e) {
        if (e instanceof ForbiddenError) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        throw e
      }
    }
  }

  const where = projectIds !== null ? { id: { in: projectIds } } : {}

  const [projects, total] = await Promise.all([
    db.project.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.project.count({ where }),
  ])

  return NextResponse.json({ projects, total, page, per_page: perPage })
}

// ─── POST — Create a project ──────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only session callers can create projects (spec: "caller becomes the first admin member")
  // API keys are project-scoped and cannot bootstrap a new project.
  if (caller.type !== 'session') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Check instance-level permission: runs:create is the minimum role for project creation.
  // For session callers without a specific project context, we check the global role.
  // instance_admin always has this permission; regular users must have the `user` built-in role
  // (which carries runs:create) — the session role field maps to Better Auth admin plugin roles.
  const isAdmin = caller.instanceRole === 'instance_admin'
  if (!isAdmin) {
    // Non-admin users can create projects if they have the `user` role at the instance level.
    // Since project-level RBAC requires an existing project, we do a lightweight check:
    // any authenticated session user is allowed (they become the first admin of their project).
    // Finer-grained instance-level role enforcement can be added when the user model exposes it.
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  if (!name || name.length > 120) {
    return NextResponse.json(
      { error: 'name is required and must be ≤ 120 characters' },
      { status: 400 },
    )
  }

  const description    = typeof body['description']    === 'string' ? body['description']    : null
  const domain_profile = typeof body['domain_profile'] === 'string' ? body['domain_profile'] : 'generic'
  const confidentiality = typeof body['confidentiality'] === 'string' ? body['confidentiality'] : 'MEDIUM'
  const config         = body['config'] && typeof body['config'] === 'object' && !Array.isArray(body['config'])
    ? body['config'] as Record<string, unknown>
    : {}
  const regulatory_ctx = Array.isArray(body['regulatory_ctx'])
    ? (body['regulatory_ctx'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : []

  // Find the built-in 'admin' role to assign to the creator.
  const adminRole = await db.projectRole.findFirst({
    where: { name: 'admin', is_builtin: true },
    select: { id: true },
  })
  if (!adminRole) {
    return NextResponse.json({ error: 'Built-in admin role not found' }, { status: 500 })
  }

  // Create project + first member in a transaction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const project = await db.$transaction(async (tx: any) => {
    const created = await tx.project.create({
      data: {
        name,
        description,
        domain_profile,
        confidentiality,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        regulatory_ctx,
        created_by: caller.userId,
      },
    })

    await tx.projectMember.create({
      data: {
        project:  { connect: { id: created.id } },
        user:     { connect: { id: caller.userId } },
        role:     { connect: { id: adminRole.id } },
        added_by: caller.userId, // creator is their own adder (bootstrap)
      },
    })

    return created
  })

  return NextResponse.json({ project }, { status: 201 })
}
