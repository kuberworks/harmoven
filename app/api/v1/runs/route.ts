// app/api/v1/runs/route.ts
// POST /api/v1/runs  — Public API v1: create a run (API key auth).
// GET  /api/v1/runs  — List recent runs for the caller's project.
//
// Security:
//   - C-02: Zod .strict() validation on POST body (aligned with /api/runs route)
//   - H-04: created_by stored as "apikey:<keyId>" for API key callers (not null)
//   - MISS-01: AuditLog written on every run creation
//   - task_input size-capped (100 KB) to prevent DoS

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
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
import { uuidv7 }                    from '@/lib/utils/uuidv7'

// ─── Validation schema ────────────────────────────────────────────────────────
const MAX_TASK_INPUT_CHARS = 100_000

const CreateV1RunBody = z.object({
  project_id:        z.string().uuid().optional(),
  task_input:        z.union([
    z.string().min(1).max(MAX_TASK_INPUT_CHARS),
    z.record(z.unknown()).refine(
      v => JSON.stringify(v).length <= MAX_TASK_INPUT_CHARS,
      { message: `task_input exceeds maximum of ${MAX_TASK_INPUT_CHARS} characters` },
    ),
    z.array(z.unknown()).refine(
      v => JSON.stringify(v).length <= MAX_TASK_INPUT_CHARS,
      { message: `task_input exceeds maximum of ${MAX_TASK_INPUT_CHARS} characters` },
    ),
  ]),
  domain_profile:    z.string().min(1).max(64),
  transparency_mode: z.boolean().optional(),
  confidentiality:   z.string().max(32).optional(),
  budget_usd:        z.number().positive().optional(),
  budget_tokens:     z.number().int().positive().optional(),
}).strict()

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

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // ─── Resolve project_id before full validation (API key derives it from DB) ─
  let projectId: string
  if (caller.type === 'api_key') {
    const keyRow = await db.projectApiKey.findUnique({
      where: { id: caller.keyId },
      select: { project_id: true },
    })
    if (!keyRow) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    projectId = keyRow.project_id
  } else {
    // Session callers must supply project_id; extract for pre-check before full Zod parse
    const raw = rawBody as Record<string, unknown>
    if (typeof raw?.['project_id'] !== 'string' || !raw['project_id']) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
    }
    projectId = raw['project_id'] as string
  }

  // ─── C-02: Zod strict validation ─────────────────────────────────────────
  const parsed = CreateV1RunBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const body = parsed.data

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

  // H-04: actor is always traceable — "apikey:<keyId>" for API key callers, userId for sessions.
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`

  const run = await db.run.create({
    data: {
      id:                uuidv7(),   // Spec T1.2: Run IDs must be UUIDv7
      project_id:        projectId,
      created_by:        actorId,    // H-04: never null — always traceable
      status:            'PENDING',
      domain_profile:    body.domain_profile,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      task_input:        body.task_input as any,
      dag:               { nodes: [], edges: [] },
      run_config:        { providers: [] },
      transparency_mode: body.transparency_mode ?? false,
      confidentiality:   body.confidentiality ?? null,
      budget_usd:        body.budget_usd ?? null,
      budget_tokens:     body.budget_tokens ?? null,
      user_injections:   [],
      metadata:          {},
      task_input_chars:  typeof body.task_input === 'string'
        ? body.task_input.length
        : JSON.stringify(body.task_input).length,
      data_expires_at: (() => { const d = new Date(); d.setDate(d.getDate() + parseInt(process.env.DATA_RETENTION_DAYS ?? '90', 10)); return d })(),
    },
  })

  // MISS-01: AuditLog on every write
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'run.created',
      run_id:      run.id,
      payload:     { domain_profile: body.domain_profile, project_id: projectId, via: 'v1' },
    },
  })

  const engine = await getExecutionEngine()
  void engine.executeRun(run.id)

  return NextResponse.json({ run }, { status: 201 })
}
