// app/api/runs/[id]/stream/route.ts
// GET /api/runs/:id/stream — SSE live event stream for a single run.
// Spec: TECHNICAL.md Section 29.6, Amendment 79.
//
// Security:
//   - Requires stream:state permission.
//   - assertRunAccess() verifies the caller is a member of the run's project.
//   - Events filtered by resolvePermissions() per connection.
//   - Cost events (stream:costs) suppressed unless caller has that permission.
//   - Gate events (stream:gates) suppressed unless caller has that permission.

import { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import type { Caller } from '@/lib/auth/rbac'
import { projectEventBus } from '@/lib/events/project-event-bus.factory'
import type { ProjectEvent, RunSSEEvent } from '@/lib/events/project-event-bus.interface'
import { db } from '@/lib/db/client'

/** TTL for the reconnect buffer query (24h). */
const RECONNECT_BUFFER_HOURS = 24

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const runId = params.id

  // ─── Auth ──────────────────────────────────────────────────────────────────
  let caller: Caller | null = null
  try {
    const session = await auth.api.getSession({ headers: req.headers })
    if (session?.user) {
      caller = {
        type: 'session',
        userId: session.user.id,
        instanceRole: (session.user as { role?: string }).role ?? null,
      }
    } else {
      // API key auth: expect Authorization: Bearer hv1_...
      const bearer = req.headers.get('authorization')?.replace('Bearer ', '')
      if (bearer) {
        const key = await db.projectApiKey.findFirst({
          where: {
            key_hash: require('crypto').createHash('sha256').update(bearer).digest('hex'),
            revoked_at: null,
          },
          select: { id: true },
        })
        if (key) caller = { type: 'api_key', keyId: key.id }
      }
    }
  } catch {
    // Auth failure → 401 below
  }

  if (!caller) {
    return new Response('Unauthorized', { status: 401 })
  }

  // ─── Run access + permission check ─────────────────────────────────────────
  let run: { project_id: string }
  try {
    run = await assertRunAccess(caller, runId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return new Response('Unauthorized', { status: 401 })
    if (e instanceof ForbiddenError)    return new Response('Forbidden',     { status: 403 })
    return new Response('Not Found', { status: 404 })
  }

  const perms = await resolvePermissions(caller, run.project_id)
  if (!perms.has('stream:state')) {
    return new Response('Forbidden', { status: 403 })
  }

  // ─── SSE stream ────────────────────────────────────────────────────────────
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      function send(event: RunSSEEvent, id?: string) {
        let data = ''
        if (id) data += `id: ${id}\n`
        data += `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(data))
      }

      function shouldSendEvent(event: RunSSEEvent): boolean {
        if (event.type === 'cost_update' || event.type === 'budget_warning') {
          return perms.has('stream:costs')
        }
        if (event.type === 'human_gate') {
          return perms.has('stream:gates')
        }
        return true
      }

      // Replay reconnect buffer if Last-Event-ID header is present
      const lastEventId = req.headers.get('last-event-id')
      if (lastEventId) {
        const since = new Date(Date.now() - RECONNECT_BUFFER_HOURS * 60 * 60 * 1000)
        db.eventPayload.findMany({
          where: { run_id: runId, created_at: { gte: since } },
          orderBy: { created_at: 'asc' },
        }).then(rows => {
          for (const row of rows) {
            try {
              const e = JSON.parse(row.payload) as RunSSEEvent
              if (shouldSendEvent(e)) send(e, row.id)
            } catch { /* skip malformed */ }
          }
        }).catch(() => { /* non-fatal */ })
      }

      // Subscribe to live events
      const unsubscribe = projectEventBus.subscribe(run.project_id, (e: ProjectEvent) => {
        if (e.run_id !== runId) return
        const sseEvent = e.event as RunSSEEvent
        if (!('type' in sseEvent)) return
        if (shouldSendEvent(sseEvent)) send(sseEvent)
      })

      // Cleanup when client disconnects
      req.signal.addEventListener('abort', () => {
        unsubscribe()
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
