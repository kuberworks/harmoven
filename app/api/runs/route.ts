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
//   - C-02: Zod .strict() validation on POST body (no mass-assignment / unknown fields).
//   - H-04: API key actorId stored as "apikey:<keyId>" — not null — for full audit trail.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { RunStatus }                 from '@prisma/client'
import type { Prisma }               from '@prisma/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
}                                    from '@/lib/auth/rbac'
import { createRunRateLimitAsync }    from '@/lib/auth/rate-limit'
import { getExecutionEngine }        from '@/lib/execution/engine.factory'
import { LlmOverridesSchema }        from '@/lib/execution/run-config'
import { uuidv7 }                    from '@/lib/utils/uuidv7'
import { classifyConfidentiality }   from '@/lib/llm/confidentiality'
import { EXCLUDE_PHANTOM_RUNS }      from '@/lib/db/run-filters'

// ─── C-02: Zod schema for POST body ──────────────────────────────────────────
// Spec: "All POST routes: Zod .strict() validation before business logic"
// project_id is optional here because API key callers derive it from the key.

// MAX_TASK_INPUT_CHARS: prevents DoS via oversized prompts and limits LLM token cost exposure.
// A 100 KB string is ~25 000 tokens — already very large for a task input.
const MAX_TASK_INPUT_CHARS = 100_000

const CreateRunBody = z.object({
  project_id:        z.string().uuid().optional(),
  task_input:        z.union([
    z.string().min(1).max(MAX_TASK_INPUT_CHARS),
    z.record(z.unknown()).refine(
      v => JSON.stringify(v).length <= MAX_TASK_INPUT_CHARS,
      { message: `task_input exceeds maximum size of ${MAX_TASK_INPUT_CHARS} characters` },
    ),
    z.array(z.unknown()).refine(
      v => JSON.stringify(v).length <= MAX_TASK_INPUT_CHARS,
      { message: `task_input exceeds maximum size of ${MAX_TASK_INPUT_CHARS} characters` },
    ),
  ]),
  domain_profile:    z.string().min(1).max(64),
  transparency_mode: z.boolean().optional(),
  confidentiality:   z.string().max(32).optional(),
  budget_usd:        z.number().positive().optional(),
  budget_tokens:     z.number().int().positive().optional(),
  // Run chaining: IDs of completed runs whose outputs feed into this run.
  // Max 5 parents; each must be COMPLETED and belong to the same project.
  parent_run_ids:    z.array(z.string().uuid()).max(5).optional(),
  enable_web_search:   z.boolean().optional().default(false),
  // User-selected output format (form selector). Stored in run_config and forwarded
  // to the PLANNER as C2 rule: overrides any desired_outputs from the CLASSIFIER.
  output_file_format: z.enum([
    'txt', 'csv', 'json', 'yaml', 'html', 'md',
    'py', 'ts', 'js', 'sh',
    'docx', 'pdf',
  ]).optional(),
  llm_overrides:     LlmOverridesSchema.optional(),
}).strict()

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

  // H-1: track whether the caller may see cost fields; instance_admin can always see costs.
  let hasCosts = isAdmin

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
    hasCosts = perms.has('runs:read_costs')
  }

  // Build filter — SEC-21: exclude phantom runs (marketplace_import) from all user-facing lists
  const where: Prisma.RunWhereInput = { ...EXCLUDE_PHANTOM_RUNS }
  if (projectId) where.project_id = projectId
  // Validate statusFilter against the RunStatus enum; invalid values yield empty result
  if (statusFilter && (Object.values(RunStatus) as string[]).includes(statusFilter)) {
    where.status = statusFilter as RunStatus
  }

  const [runs, total] = await Promise.all([
    db.run.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.run.count({ where }),
  ])

  // H-1: redact cost fields for callers without runs:read_costs — mirrors single-run GET.
  const safeRuns = hasCosts
    ? runs
    : runs.map(r => ({ ...r, cost_actual_usd: undefined, tokens_actual: undefined }))

  return NextResponse.json({ runs: safeRuns, total, page, per_page: perPage })
}

export async function POST(req: NextRequest) {
  // Rate limit: 10 runs/min per IP.
  const rateLimitResponse = await createRunRateLimitAsync(req)
  if (rateLimitResponse) return rateLimitResponse

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // C-02: parse + strict-validate body before touching any business logic.
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = CreateRunBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const body = parsed.data

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
    if (!body.project_id) {
      return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
    }
    projectId = body.project_id
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

  // Validate LLM override profile IDs against enabled profiles in the DB.
  // We reject unknown / disabled profile IDs so the executor never tries to use a ghost profile.
  if (body.llm_overrides) {
    const overrideIds = Object.values(body.llm_overrides).filter(Boolean) as string[]
    if (overrideIds.length > 0) {
      const validProfiles = await db.llmProfile.findMany({
        where: { id: { in: overrideIds }, enabled: true },
        select: { id: true },
      })
      const validIds = new Set(validProfiles.map(p => p.id))
      const invalid = overrideIds.filter(id => !validIds.has(id))
      if (invalid.length > 0) {
        return NextResponse.json(
          { error: `Invalid or disabled LLM profile IDs: ${invalid.join(', ')}` },
          { status: 422 },
        )
      }
    }
  }

  // H-04: store a meaningful actor for API key callers ("apikey:<keyId>") so
  // AuditLog is never null/system for programmatic run creation.
  const actorId = caller.type === 'session'
    ? caller.userId
    : `apikey:${caller.keyId}`

  // H-04: created_by stores actorId so any run is traceable to a user or key.
  const createdBy = caller.type === 'session' ? caller.userId : actorId

  // Section 18 AGENTS-01 — Local confidentiality classification.
  // If the caller supplied a confidentiality level, use it as a floor; otherwise
  // let the classifier determine it. The classifier result is authoritative when
  // more restrictive than the caller-supplied value.
  const taskInputStr = typeof body.task_input === 'string'
    ? body.task_input
    : JSON.stringify(body.task_input)

  const classificationResult = classifyConfidentiality(taskInputStr)
  const LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
  type Level = typeof LEVELS[number]
  const callerLevel = (body.confidentiality?.toUpperCase() ?? 'LOW') as Level
  const classifiedLevel = classificationResult.score
  const effectiveConfidentiality =
    LEVELS.indexOf(classifiedLevel) > LEVELS.indexOf(callerLevel)
      ? classifiedLevel
      : callerLevel

  // Bootstrap the DAG with CLASSIFIER (n1) → PLANNER (n2).
  // The CLASSIFIER classifies intent; the PLANNER decomposes into WRITER/REVIEWER nodes.
  // After PLANNER completes, the executor expands the DAG with the plan's nodes.
  const classifierNodeId = 'n1'
  const plannerNodeId    = 'n2'
  const initialDag = {
    nodes: [
      { id: classifierNodeId, agent_type: 'CLASSIFIER' },
      { id: plannerNodeId,    agent_type: 'PLANNER'    },
    ],
    edges: [{ from: classifierNodeId, to: plannerNodeId }],
  }

  // Create PENDING run. Spec T1.2: all new Run IDs must use UUIDv7.
  const run = await db.run.create({
    data: {
      id:               uuidv7(),
      project_id:       projectId,
      created_by:       createdBy,
      status:           'PENDING',
      domain_profile:   body.domain_profile,
      task_input:       body.task_input as Prisma.InputJsonValue,
      dag:              initialDag,
      run_config:       {
        providers: [],
        ...(body.enable_web_search   ? { enable_web_search: true } : {}),
        ...(body.output_file_format  ? { output_file_format: body.output_file_format } : {}),
        ...(body.llm_overrides       ? { llm_overrides: body.llm_overrides } : {}),
      },
      transparency_mode: body.transparency_mode ?? false,
      // Section 18: use the higher of the caller-supplied level and the local classifier result.
      confidentiality:  effectiveConfidentiality,
      budget_usd:       body.budget_usd ?? null,
      budget_tokens:    body.budget_tokens ?? null,
      user_injections:  [],
      metadata:         {},
      task_input_chars: typeof body.task_input === 'string'
        ? body.task_input.length
        : JSON.stringify(body.task_input).length,
      data_expires_at: (() => { const d = new Date(); d.setDate(d.getDate() + parseInt(process.env.DATA_RETENTION_DAYS ?? '90', 10)); return d })(),
    },
  })

  // Create the initial CLASSIFIER and PLANNER Node DB records.
  // Both are PENDING; the PLANNER becomes ready only after CLASSIFIER completes.
  const nodeBase = {
    started_at: null, completed_at: null, interrupted_at: null, interrupted_by: null,
    last_heartbeat: null, retries: 0, partial_output: null, partial_updated_at: null,
    cost_usd: 0, tokens_in: 0, tokens_out: 0, error: null,
  }
  await db.node.createMany({
    data: [
      {
        ...nodeBase,
        id: uuidv7(), run_id: run.id, node_id: classifierNodeId,
        agent_type: 'CLASSIFIER', status: 'PENDING',
        // Stash task_input so the runner reads it as the initial handoff
        // (CLASSIFIER has no predecessor → handoffIn is null).
        metadata: { task_input: taskInputStr },
      },
      {
        ...nodeBase,
        id: uuidv7(), run_id: run.id, node_id: plannerNodeId,
        agent_type: 'PLANNER', status: 'PENDING',
        // Stash task_input and domain_profile as fallbacks.
        metadata: {
          task_input:     taskInputStr,
          domain_profile: body.domain_profile,
          ...(body.llm_overrides?.PLANNER ? { preferred_llm: body.llm_overrides.PLANNER } : {}),
        },
      },
    ],
  })

  // AuditLog: every write operation must be recorded (spec MISS-01).
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'run.created',
      run_id:      run.id,
      payload: {
        domain_profile: body.domain_profile,
        project_id:     projectId,
      },
    },
  })

  // Run chaining: validate and persist parent dependencies.
  if (body.parent_run_ids && body.parent_run_ids.length > 0) {
    const parentRuns = await db.run.findMany({
      where: { id: { in: body.parent_run_ids } },
      select: { id: true, status: true, project_id: true },
    })
    // Validate: all must exist, be COMPLETED, and belong to the same project.
    // Use a single generic error for "not found" and "wrong project" to prevent
    // IDOR: distinct messages would reveal whether a foreign-project run ID exists.
    for (const pid of body.parent_run_ids) {
      const parent = parentRuns.find(p => p.id === pid)
      if (!parent || parent.project_id !== projectId) {
        return NextResponse.json({ error: `Parent run ${pid} not found` }, { status: 422 })
      }
      if (parent.status !== 'COMPLETED') {
        return NextResponse.json({ error: `Parent run ${pid} is not COMPLETED (status: ${parent.status})` }, { status: 422 })
      }
    }
    await db.runDependency.createMany({
      data: body.parent_run_ids.map(pid => ({
        child_run_id:  run.id,
        parent_run_id: pid,
      })),
      skipDuplicates: true,
    })
  }

  // Enqueue asynchronously — route returns 201 immediately.
  try {
    const engine = await getExecutionEngine()
    void engine.executeRun(run.id)
  } catch (err) {
    // Engine initialisation failed (e.g. DB unavailable, LLM profile load error).
    // The run record is already committed — return 202 so the client knows the run
    // was created and can retry or poll. Do not return 500 (which would produce
    // non-JSON from Next.js and cause the client's res.json() to throw).
    console.error('[POST /api/runs] Engine init failed — run created but not enqueued:', err)
    return NextResponse.json(
      { run, warning: 'Run created but could not be enqueued. The executor will retry on next startup.' },
      { status: 202 },
    )
  }

  return NextResponse.json({ run }, { status: 201 })
}
