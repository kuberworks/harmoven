// app/api/projects/[id]/route.ts
// GET    /api/projects/:id  — Fetch project details
// PATCH  /api/projects/:id  — Update project metadata; auto-commits config to config.git
// DELETE /api/projects/:id  — Soft-archive project (spec TECHNICAL.md §8 L.773)
// Spec: T2B.2 (DoD gap — PATCH missing), TECHNICAL.md §16.

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
}                                    from '@/lib/auth/rbac'
import { updateProjectConfig }       from '@/lib/projects/project-service'

type Params = { params: Promise<{ id: string }> }

// Fields allowed in a PATCH body (server-side allow-list — injection prevention).
const PATCHABLE_SCALAR = new Set(['name', 'description', 'domain_profile', 'confidentiality'])
const PATCHABLE_JSON   = new Set(['config', 'regulatory_ctx'])

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let project
  try {
    project = await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ project })
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:edit')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const actorId = caller.type === 'session'
    ? caller.userId
    : `apikey:${caller.keyId}`

  // Strip unknown / non-patchable fields (prevent mass-assignment).
  const scalarData: Record<string, unknown> = {}
  for (const key of Object.keys(body)) {
    if (PATCHABLE_SCALAR.has(key)) scalarData[key] = body[key]
  }

  const hasConfig   = PATCHABLE_JSON.has('config') && 'config' in body
  const hasReguCtx  = PATCHABLE_JSON.has('regulatory_ctx') && 'regulatory_ctx' in body

  if (Object.keys(scalarData).length === 0 && !hasConfig && !hasReguCtx) {
    return NextResponse.json({ error: 'No patchable fields provided' }, { status: 400 })
  }

  // 1. Scalar fields — direct DB update.
  const dbData: Record<string, unknown> = { ...scalarData }
  if (hasReguCtx) dbData['regulatory_ctx'] = body['regulatory_ctx']

  if (Object.keys(dbData).length > 0) {
    await db.project.update({ where: { id: projectId }, data: dbData })
  }

  // 2. config blob — DB update + auto-commit to config.git (fire-and-forget on git).
  if (hasConfig) {
    await updateProjectConfig(
      projectId,
      body['config'] as Record<string, unknown>,
      actorId,
      `PATCH /api/projects/${projectId} by ${actorId}`,
    )
  }

  const project = await db.project.findUnique({ where: { id: projectId } })
  return NextResponse.json({ project })
}

// ─── DELETE (archive) ─────────────────────────────────────────────────────────
// Soft-delete: sets archived_at timestamp. Active runs are not aborted.
// Requires project:edit permission (same as PATCH — only members with edit rights).

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:edit')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await db.project.update({
    where: { id: projectId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data:  { archived_at: new Date() } as any,
  })

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  await db.auditLog.create({
    data: {
      run_id:      null,
      actor:       actorId,
      action_type: 'project.archived',
      payload:     { project_id: projectId },
    },
  })

  return new NextResponse(null, { status: 204 })
}
