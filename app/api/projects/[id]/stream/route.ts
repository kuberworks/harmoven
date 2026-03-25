// app/api/projects/[id]/stream/route.ts
// GET /api/projects/:id/stream — SSE project-level event stream.
// Spec: TECHNICAL.md Section 29.6, Amendment 79.
//
// Receives ALL run events for a project (for the project dashboard live feed).
// Security:
//   - Requires stream:project permission.
//   - assertProjectAccess() verifies the caller is a member.
//   - Cost events (stream:costs) suppressed unless caller has that permission.
//   - Gate events (stream:gates) suppressed unless caller has that permission.

import { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import type { Caller } from '@/lib/auth/rbac'
import { projectEventBus } from '@/lib/events/project-event-bus.factory'
import type { ProjectEvent, RunSSEEvent } from '@/lib/events/project-event-bus.interface'
import { db } from '@/lib/db/client'

const RECONNECT_BUFFER_HOURS = 24

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const projectId = params.id

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

  // ─── Project access + permission check ─────────────────────────────────────
  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return new Response('Unauthorized', { status: 401 })
    if (e instanceof ForbiddenError)    return new Response('Forbidden',     { status: 403 })
    return new Response('Not Found', { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('stream:project')) {
    return new Response('Forbidden', { status: 403 })
  }

  // ─── SSE stream ────────────────────────────────────────────────────────────
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      function send(event: RunSSEEvent | { type: string }, id?: string) {
        let data = ''
        if (id) data += `id: ${id}\n`
        data += `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(data))
      }

      function shouldSendEvent(event: ProjectEvent['event']): boolean {
        const t = (event as { type: string }).type
        if (t === 'cost_update' || t === 'budget_warning') return perms.has('stream:costs')
        if (t === 'human_gate')                             return perms.has('stream:gates')
        return true
      }

      // Reconnect buffer replay
      const lastEventId = req.headers.get('last-event-id')
      if (lastEventId) {
        const since = new Date(Date.now() - RECONNECT_BUFFER_HOURS * 60 * 60 * 1000)
        db.eventPayload.findMany({
          where: { project_id: projectId, created_at: { gte: since } },
          orderBy: { created_at: 'asc' },
        }).then(rows => {
          for (const row of rows) {
            try {
              const parsed = JSON.parse(row.payload) as ProjectEvent
              if (shouldSendEvent(parsed.event)) send(parsed.event as RunSSEEvent, row.id)
            } catch { /* skip malformed */ }
          }
        }).catch(() => { /* non-fatal */ })
      }

      // Subscribe to live events
      const unsubscribe = projectEventBus.subscribe(projectId, (e: ProjectEvent) => {
        if (shouldSendEvent(e.event)) send(e.event as RunSSEEvent)
      })

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
