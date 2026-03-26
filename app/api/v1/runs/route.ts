// app/api/v1/runs/route.ts
// POST /api/v1/runs  — Public API v1: create a run (API key auth).
// GET  /api/v1/runs  — List recent runs for the caller's project.
// MISS-06 (audit gap).

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
}                                    from '@/lib/auth/rbac'
import { createRunRateLimit }        from '@/lib/auth/rate-limit'
import { getExecutionEngine }        from '@/lib/execution/engine.factory'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const projectId = req.nextUrl.searchParams.get('project_id')
  if (!projectId) {
    return NextResponse.json({ error: 'project_id query parameter is required' }, { status: 400 })
  }

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

  const limit  = Math.min(parseInt(req.nextUrl.searchParams.get('limit')  ?? '50',  10), 200)
  const offset = Math.max(parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10), 0)

  const runs = await db.run.findMany({
    where:   { project_id: projectId },
    orderBy: { created_at: 'desc' },
    take:    limit,
    skip:    offset,
    select: {
      id: true, project_id: true, status: true, domain_profile: true,
      cost_actual_usd: true, tokens_actual: true, budget_usd: true,
      started_at: true, completed_at: true, created_at: true,
    },
  })

  return NextResponse.json({ runs, limit, offset })
}

export async function POST(req: NextRequest) {
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

  if (!body['task_input'] && body['task_input'] !== 0) {
    return NextResponse.json({ error: 'task_input is required' }, { status: 400 })
  }
  if (typeof body['domain_profile'] !== 'string' || !body['domain_profile']) {
    return NextResponse.json({ error: 'domain_profile is required' }, { status: 400 })
  }

  const run = await db.run.create({
    data: {
      project_id:        projectId,
      created_by:        caller.type === 'session' ? caller.userId : null,
      status:            'PENDING',
      domain_profile:    body['domain_profile'] as string,
      task_input:        body['task_input'],
      dag:               { nodes: [], edges: [] },
      run_config:        { providers: [] },
      transparency_mode: typeof body['transparency_mode'] === 'boolean' ? body['transparency_mode'] : false,
      confidentiality:   typeof body['confidentiality'] === 'string' ? body['confidentiality'] : null,
      budget_usd:        typeof body['budget_usd'] === 'number' ? body['budget_usd'] : null,
      budget_tokens:     typeof body['budget_tokens'] === 'number' ? body['budget_tokens'] : null,
      user_injections:   [],
      metadata:          {},
      task_input_chars:  typeof body['task_input'] === 'string'
        ? body['task_input'].length
        : JSON.stringify(body['task_input']).length,
    },
  })

  const engine = await getExecutionEngine()
  void engine.executeRun(run.id)

  return NextResponse.json({ run }, { status: 201 })
}
