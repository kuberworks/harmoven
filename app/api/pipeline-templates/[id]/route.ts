// GET    /api/pipeline-templates/:id          — Get one template with versions
// PUT    /api/pipeline-templates/:id          — Update (creates new version if dag changes)
// DELETE /api/pipeline-templates/:id          — Delete template
import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { getTemplate, updateTemplate, deleteTemplate } from '@/lib/pipeline/templates'
import type { Dag } from '@/types/dag.types'

// SEC-H-05: Maximum serialised size (bytes) for a DAG payload.
const MAX_DAG_BYTES = 512_000

type Params = { params: Promise<{ id: string }> }

/**
 * Assert that a caller can read the given template.
 * - Public global templates (is_public=true, project_id=null) → any authenticated user.
 * - Project-scoped templates → must be a member of the project.
 * - Private global templates (is_public=false, project_id=null) → creator or instance_admin.
 *
 * Returns 404 on failure (prevents enumeration — same response as truly missing).
 */
async function assertTemplateReadAccess(
  caller: Awaited<ReturnType<typeof resolveCaller>>,
  template: NonNullable<Awaited<ReturnType<typeof getTemplate>>>,
): Promise<NextResponse | null> {
  if (!caller) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const userId  = caller.type === 'session' ? caller.userId : null
  const isAdmin = caller.type === 'session' && caller.instanceRole === 'instance_admin'

  // Public global template — accessible to everyone
  if (template.is_public && !template.project_id) return null

  // Project-scoped template — must be a member
  if (template.project_id) {
    try {
      await assertProjectAccess(caller, template.project_id)
      return null
    } catch (e) {
      if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  }

  // Private global template — creator or instance_admin only
  if (isAdmin || (userId && template.created_by === userId)) return null

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export async function GET(_req: NextRequest, { params }: Params) {
  const caller = await resolveCaller(_req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const template = await getTemplate(id)
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // H-2 fix: enforce visibility rules (was missing — IDOR)
  const accessErr = await assertTemplateReadAccess(caller, template)
  if (accessErr) return accessErr

  return NextResponse.json({ template })
}

export async function PUT(req: NextRequest, { params }: Params) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = caller.type === 'session' ? caller.userId : null
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const existing = await getTemplate(id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Only the creator or an instance_admin can modify
  const isAdmin = caller.type === 'session' && caller.instanceRole === 'instance_admin'
  if (!isAdmin && existing.created_by !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { name, description, is_public, dag, change_note } = body as Record<string, unknown>

  // SEC-H-05: Enforce maximum DAG payload size before writing to DB.
  if (dag && JSON.stringify(dag).length > MAX_DAG_BYTES) {
    return NextResponse.json(
      { error: `DAG payload exceeds maximum allowed size of ${MAX_DAG_BYTES} bytes` },
      { status: 422 },
    )
  }

  const updated = await updateTemplate(id, {
    name:        typeof name        === 'string' ? name        : undefined,
    description: typeof description === 'string' ? description : undefined,
    is_public:   typeof is_public   === 'boolean' ? is_public  : undefined,
    dag:         dag ? dag as Dag : undefined,
    change_note: typeof change_note === 'string' ? change_note : undefined,
    updated_by:  userId,
  })

  return NextResponse.json({ template: updated })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const caller = await resolveCaller(_req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = caller.type === 'session' ? caller.userId : null
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const existing = await getTemplate(id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const isAdmin = caller.type === 'session' && caller.instanceRole === 'instance_admin'
  if (!isAdmin && existing.created_by !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await deleteTemplate(id)
  return new NextResponse(null, { status: 204 })
}
