// GET  /api/pipeline-templates       — List templates visible to caller
// POST /api/pipeline-templates       — Create a new pipeline template
import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { listTemplates, createTemplate } from '@/lib/pipeline/templates'
import type { Dag } from '@/types/dag.types'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = caller.type === 'session' ? caller.userId : null
  if (!userId) return NextResponse.json({ error: 'API key callers cannot list templates' }, { status: 403 })

  const { searchParams } = req.nextUrl
  const project_id = searchParams.get('project_id') ?? undefined

  const templates = await listTemplates({ user_id: userId, project_id })
  return NextResponse.json({ templates })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = caller.type === 'session' ? caller.userId : null
  if (!userId) return NextResponse.json({ error: 'API key callers cannot create templates' }, { status: 403 })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { name, description, project_id, is_public, dag } = body as Record<string, unknown>

  if (!name || typeof name !== 'string') return NextResponse.json({ error: '`name` is required' }, { status: 422 })
  if (!dag || typeof dag !== 'object' || !Array.isArray((dag as Dag).nodes) || !Array.isArray((dag as Dag).edges)) {
    return NextResponse.json({ error: '`dag` must be { nodes: [], edges: [] }' }, { status: 422 })
  }

  const template = await createTemplate({
    name,
    description: typeof description === 'string' ? description : undefined,
    project_id:  typeof project_id  === 'string' ? project_id  : undefined,
    is_public:   is_public === true,
    dag:         dag as Dag,
    created_by:  userId,
  })

  return NextResponse.json({ template }, { status: 201 })
}
