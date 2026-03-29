// POST /api/pipeline-templates/:id/feedback
// Records a run outcome against a template and may trigger an AI improvement suggestion.
// POST /api/pipeline-templates/:id/suggestion/accept
// Accepts the stored AI suggestion, creating a new version.
import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { getTemplate }               from '@/lib/pipeline/templates'
import { recordFeedback, acceptSuggestion } from '@/lib/pipeline/ai-suggestions'

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = caller.type === 'session' ? caller.userId : null
  if (!userId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const template = await getTemplate(id)
  if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { run_id, user_rating, change_note, accept_suggestion } = body as Record<string, unknown>

  // Accept the pending AI suggestion
  if (accept_suggestion === true) {
    await acceptSuggestion(id, userId)
    return NextResponse.json({ accepted: true })
  }

  // Record run feedback (may trigger AI suggestion generation async)
  if (!run_id || typeof run_id !== 'string') {
    return NextResponse.json({ error: '`run_id` is required' }, { status: 422 })
  }

  await recordFeedback({
    template_id:  id,
    run_id,
    user_rating:  typeof user_rating  === 'number' ? user_rating  : undefined,
    change_note:  typeof change_note  === 'string'  ? change_note  : undefined,
  })

  return NextResponse.json({ recorded: true })
}
