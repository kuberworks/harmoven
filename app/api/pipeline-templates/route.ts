// GET  /api/pipeline-templates       — List templates visible to caller
// POST /api/pipeline-templates       — Create a new pipeline template
import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import { listTemplates, createTemplate } from '@/lib/pipeline/templates'
import type { Dag } from '@/types/dag.types'

// SEC-H-05: Maximum serialised size (bytes) for a DAG payload.
// Prevents unbounded storage and LLM context overflow.
const MAX_DAG_BYTES = 512_000

// M-2 fix: strict Zod schema — replaces unsafe `body as Record<string, unknown>` cast.
const CreateTemplateBody = z.object({
  name:        z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  project_id:  z.string().uuid().optional(),
  is_public:   z.boolean().optional(),
  dag: z.object({
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
  }).passthrough(),
}).strict()

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = caller.type === 'session' ? caller.userId : null
  if (!userId) return NextResponse.json({ error: 'API key callers cannot list templates' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const project_id = searchParams.get('project_id') ?? undefined

  // SEC-M-01: If filtering by project, verify the caller is a member of that project.
  // Without this check any authenticated user could enumerate another project's templates
  // by passing an arbitrary project_id query parameter.
  if (project_id) {
    try {
      await assertProjectAccess(caller, project_id)
    } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const templates = await listTemplates({ user_id: userId, project_id })
  return NextResponse.json({ templates })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = caller.type === 'session' ? caller.userId : null
  if (!userId) return NextResponse.json({ error: 'API key callers cannot create templates' }, { status: 403 })

  let rawBody: unknown
  try { rawBody = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const parsed = CreateTemplateBody.safeParse(rawBody)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { name, description, project_id, is_public, dag } = parsed.data

  // SEC-H-05: Enforce maximum DAG payload size before writing to DB.
  if (JSON.stringify(dag).length > MAX_DAG_BYTES) {
    return NextResponse.json(
      { error: `DAG payload exceeds maximum allowed size of ${MAX_DAG_BYTES} bytes` },
      { status: 422 },
    )
  }

  // SEC-M-01: If scoping to a project, verify the caller is a member of that project.
  if (project_id) {
    try {
      await assertProjectAccess(caller, project_id)
    } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const template = await createTemplate({
    name,
    description,
    project_id,
    is_public:   is_public ?? false,
    dag:         dag as Dag,
    created_by:  userId,
  })

  return NextResponse.json({ template }, { status: 201 })
}
