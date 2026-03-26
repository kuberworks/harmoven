// app/api/runs/[runId]/inject/route.ts
// POST /api/runs/:runId/inject
// Append a context note to a RUNNING or PAUSED run.
// Amendment 64.
//
// Auth: runs:inject permission required.
// Body: { content: string } — max 2000 chars.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { getExecutionEngine } from '@/lib/execution/engine.factory'

interface InjectBody {
  content: string
}

const MAX_CONTENT_LENGTH = 2000

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const runLookup = await db.run.findUnique({
    where: { id: runId },
    select: { project_id: true },
  })
  if (!runLookup) return NextResponse.json({ error: 'Not Found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, runLookup.project_id)
    await assertRunAccess(runId, runLookup.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'     }, { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, runLookup.project_id)
  if (!perms.has('runs:inject')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Validate body ────────────────────────────────────────────────────────
  let body: InjectBody
  try {
    body = await req.json() as InjectBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { content } = body
  if (typeof content !== 'string' || content.trim().length === 0) {
    return NextResponse.json({ error: 'content must be a non-empty string' }, { status: 400 })
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json(
      { error: `content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters` },
      { status: 422 },
    )
  }

  // ─── Inject ───────────────────────────────────────────────────────────────
  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  try {
    const engine = await getExecutionEngine()
    const injection = await engine.injectContext(runId, content, actorId)
    return NextResponse.json({ ok: true, injection })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('Cannot inject') || message.includes('status')) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
