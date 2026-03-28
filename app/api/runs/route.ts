// app/api/runs/route.ts
// GET  /api/runs  — List runs for a project (paginated, session auth)
// POST /api/runs — Create and enqueue a new run.
// Spec: MISS-01 (audit gap), T2B.2 adjacent, TECHNICAL.md §14 (run lifecycle).
//
// Security:
//   - Requires a valid session or project-scoped API key.
//   - API key callers: project derived from the key (not user-supplied).
//   - Session callers: must supply project_id in the body (POST) or query (GET).
//   - Requires runs:create (POST) or runs:read (GET) permission on the target project.
//   - POST rate-limited to 10 requests/min per IP (MISS-12, T1.3).

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import type { Prisma }               from '@prisma/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
}                                    from '@/lib/auth/rbac'
import { createRunRateLimit }        from '@/lib/auth/rate-limit'
import { getExecutionEngine }        from '@/lib/execution/engine.factory'
import { uuidv7 }                    from '@/lib/utils/uuidv7'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const page    = Math.max(1, parseInt(searchParams.get('page')     ?? '1',  10) || 1)
  const perPage = Math.min(100, Math.max(1, parseInt(searchParams.get('per_page') ?? '20', 10) || 20))
  const statusFilter = searchParams.get('status')

  const isAdmin = caller.type === 'session' && caller.instanceRole === 'instance_admin'

  let projectId: string | null = null

  if (caller.type === 'api_key') {
    const keyRow = await db.projectApiKey.findUnique({
      where: { id: caller.keyId },
      select: { project_id: true, revoked_at: true, expires_at: true },
    })
    if (!keyRow || keyRow.revoked_at || (keyRow.expires_at && keyRow.expires_at < new Date())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    projectId = keyRow.project_id
  } else {
    const qpProjectId = searchParams.get('project_id')
    if (!qpProjectId && !isAdmin) {
      return NextResponse.json({ error: 'project_id query parameter is required' }, { status: 400 })
    }
    projectId = qpProjectId
  }

  if (projectId) {
    try {
      await assertProjectAccess(caller, projectId)
    } catch (e) {
      if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const perms = await resolvePermissions(caller, projectId)
    if (!perms.has('runs:read')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Build filter
  const where: Prisma.RunWhereInput = {}
  if (projectId) where.project_id = projectId
  // Cast statusFilter: spec values match RunStatus enum; invalid values yield empty result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (statusFilter) where.status = statusFilter as any

  const [runs, total] = await Promise.all([
    db.run.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.run.count({ where }),
  ])

  return NextResponse.json({ runs, total, page, per_page: perPage })
}

export async function POST(req: NextRequest) {
  // Rate limit: 10 runs/min per IP.
  const rateLimitResponse = createRunRateLimit(req)
  if (rateLimitResponse) return rateLimitResponse

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Determine project_id:
  //   - API key callers → project is the key's project (no user override allowed).
  //   - Session callers → must supply project_id in the body.
  let projectId: string
  if (caller.type === 'api_key') {
    const keyRow = await db.projectApiKey.findUnique({
      where: { id: caller.keyId },
      select: { project_id: true },
    })
    if (!keyRow) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    projectId = keyRow.project_id
  } else {
    if (typeof body['project_id'] !== 'string' || !body['project_id']) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
    }
    projectId = body['project_id'] as string
  }

  // Auth: verify access + permission.
  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('runs:create')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Validate required fields.
  if (!body['task_input'] && body['task_input'] !== 0) {
    return NextResponse.json({ error: 'task_input is required' }, { status: 400 })
  }
  if (typeof body['domain_profile'] !== 'string' || !body['domain_profile']) {
    return NextResponse.json({ error: 'domain_profile is required' }, { status: 400 })
  }

  const actorId = caller.type === 'session' ? caller.userId : null

  // Create PENDING run; DAG is empty until the Planner agent runs.
  // Spec T1.2: all new Run IDs must use UUIDv7 for time-sortable ordering.
  const run = await db.run.create({
    data: {
      id:               uuidv7(),
      project_id:       projectId,
      created_by:       actorId,
      status:           'PENDING',
      domain_profile:   body['domain_profile'] as string,
      task_input:       body['task_input'],
      dag:              { nodes: [], edges: [] },
      run_config:       { providers: [] },
      transparency_mode: typeof body['transparency_mode'] === 'boolean'
        ? body['transparency_mode']
        : false,
      confidentiality:  typeof body['confidentiality'] === 'string'
        ? body['confidentiality']
        : null,
      budget_usd:       typeof body['budget_usd'] === 'number'
        ? body['budget_usd']
        : null,
      budget_tokens:    typeof body['budget_tokens'] === 'number'
        ? body['budget_tokens']
        : null,
      user_injections:  [],
      metadata:         {},
      task_input_chars: typeof body['task_input'] === 'string'
        ? body['task_input'].length
        : JSON.stringify(body['task_input']).length,
    },
  })

  // AuditLog: every write operation must be recorded (spec MISS-01).
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId ?? 'system',
      action_type: 'run.created',
      run_id:      run.id,
      payload: {
        domain_profile: body['domain_profile'],
        project_id:     projectId,
      },
    },
  })

  // Enqueue asynchronously — route returns 201 immediately.
  const engine = await getExecutionEngine()
  void engine.executeRun(run.id)

  return NextResponse.json({ run }, { status: 201 })
}
