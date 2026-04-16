// POST /api/pipeline-templates/:id/feedback
// Records a run outcome against a template and may trigger an AI improvement suggestion.
// POST /api/pipeline-templates/:id/suggestion/accept
// Accepts the stored AI suggestion, creating a new version.
import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import { assertRunAccess }           from '@/lib/auth/ownership'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { getTemplate }               from '@/lib/pipeline/templates'
import { recordFeedback, acceptSuggestion } from '@/lib/pipeline/ai-suggestions'

type Params = { params: Promise<{ id: string }> }

const FeedbackBody = z.object({
  run_id:            z.string().uuid().optional(),
  user_rating:       z.number().min(1).max(5).optional(),
  change_note:       z.string().max(1000).optional(),
  accept_suggestion: z.boolean().optional(),
}).strict()

export async function POST(req: NextRequest, { params }: Params) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (caller.type !== 'session') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const userId = caller.userId
  const isAdmin = caller.instanceRole === 'instance_admin'

  const { id } = await params
  const template = await getTemplate(id)
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // H-3 fix: verify caller has access to the template before any mutation.
  const isCreator = template.created_by === userId

  // Project-scoped template → must be a member
  if (template.project_id) {
    try {
      await assertProjectAccess(caller, template.project_id)
    } catch (e) {
      if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
  } else if (!template.is_public) {
    // Private global template — only creator or admin may interact
    if (!isAdmin && !isCreator) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const parsed = FeedbackBody.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { run_id, user_rating, change_note, accept_suggestion } = parsed.data

  // Accept the pending AI suggestion — only creator or admin
  if (accept_suggestion === true) {
    if (!isAdmin && !isCreator) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    await acceptSuggestion(id, userId)
    return NextResponse.json({ accepted: true })
  }

  // Record run feedback
  if (!run_id) {
    return NextResponse.json({ error: '`run_id` is required' }, { status: 422 })
  }

  // H-3 fix: validate caller has access to the referenced run (IDOR linkage)
  try {
    const { db } = await import('@/lib/db/client')
    const runRow = await db.run.findUnique({ where: { id: run_id }, select: { project_id: true } })
    if (runRow) {
      await assertProjectAccess(caller, runRow.project_id)
      await assertRunAccess(run_id, runRow.project_id)
    }
    // If runRow is null, still allow feedback creation — run may have been deleted
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden' },    { status: 403 })
  }

  await recordFeedback({
    template_id:  id,
    run_id,
    user_rating,
    change_note,
  })

  return NextResponse.json({ recorded: true })
}
