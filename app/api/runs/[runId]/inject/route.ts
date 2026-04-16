// app/api/runs/[runId]/inject/route.ts
// POST /api/runs/:runId/inject
// Append a context note to a RUNNING or PAUSED run.
// Amendment 64.
//
// Auth: runs:inject permission required.
// Body: { content: string } — max 2000 chars.
// C-02: Zod .strict() replaces manual cast (no unknown fields accepted).

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'
import { getExecutionEngine } from '@/lib/execution/engine.factory'

const MAX_CONTENT_LENGTH = 2000

const InjectBody = z.object({
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
}).strict()

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
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = InjectBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const { content } = parsed.data

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
