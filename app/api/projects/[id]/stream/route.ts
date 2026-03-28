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
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { projectEventBus } from '@/lib/events/project-event-bus.factory'
import type { ProjectEvent, RunSSEEvent } from '@/lib/events/project-event-bus.interface'
import { db } from '@/lib/db/client'

/** SSE heartbeat interval — spec §34.4 “30s heartbeat”. */
const HEARTBEAT_MS = 30_000

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const projectId = id

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return new Response(
    JSON.stringify({ error: 'Unauthorized' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  )

  // ─── Project access + permission check ─────────────────────────────────────
  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
    if (e instanceof ForbiddenError) return new Response(
      JSON.stringify({ error: 'Forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
    return new Response(
      JSON.stringify({ error: 'Not Found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('stream:project')) return new Response(
    JSON.stringify({ error: 'Forbidden' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  )

  // ─── SSE stream ────────────────────────────────────────────────────────────
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null

      function sendRaw(data: string) {
        controller.enqueue(encoder.encode(data))
      }

      function send(event: RunSSEEvent | { type: string }, id?: string) {
        let data = ''
        if (id) data += `id: ${id}\n`
        data += `data: ${JSON.stringify(event)}\n\n`
        sendRaw(data)
      }

      function sendHeartbeat() {
        sendRaw(': heartbeat\n\n')
      }

      function shouldSendEvent(event: ProjectEvent['event']): boolean {
        const t = (event as { type: string }).type
        if (t === 'cost_update' || t === 'budget_warning') return perms.has('stream:costs')
        if (t === 'human_gate')                             return perms.has('stream:gates')
        return true
      }

      // Replay missed events when Last-Event-ID is present
      const lastEventId = req.headers.get('last-event-id')
      if (lastEventId) {
        try {
          const rows = await db.eventPayload.findMany({
            where: { project_id: projectId, id: { gt: lastEventId } },
            orderBy: { created_at: 'asc' },
          })
          for (const row of rows) {
            try {
              const parsed = JSON.parse(row.payload) as ProjectEvent
              if (shouldSendEvent(parsed.event)) send(parsed.event as RunSSEEvent, row.id)
            } catch { /* skip malformed */ }
          }
        } catch { /* non-fatal */ }
      }

      // Subscribe to live events
      const unsubscribe = projectEventBus.subscribe(projectId, (e: ProjectEvent) => {
        if (shouldSendEvent(e.event)) send(e.event as RunSSEEvent)
      })

      // 30s heartbeat to keep connection alive through proxies (§34.4)
      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS)

      req.signal.addEventListener('abort', () => {
        unsubscribe()
        if (heartbeatTimer) clearInterval(heartbeatTimer)
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
