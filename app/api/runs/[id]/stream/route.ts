// app/api/runs/[id]/stream/route.ts
// GET /api/runs/:id/stream — SSE live event stream for a single run.
// Spec: TECHNICAL.md Section 29.6, Amendment 79.
//
// Security:
//   - Requires stream:state permission.
//   - assertProjectAccess() + assertRunAccess() ensures caller is a member.
//   - Events filtered by resolvePermissions() per connection.
//   - Cost events (stream:costs) suppressed unless caller has that permission.
//   - Gate events (stream:gates) suppressed unless caller has that permission.

import { NextRequest } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { projectEventBus } from '@/lib/events/project-event-bus.factory'
import type { ProjectEvent, RunSSEEvent } from '@/lib/events/project-event-bus.interface'
import { db } from '@/lib/db/client'

/** TTL for the reconnect buffer query (24h). */
const RECONNECT_BUFFER_HOURS = 24

/** SSE heartbeat interval — spec §34.4 "30s heartbeat". */
const HEARTBEAT_MS = 30_000

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const runId = id

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return new Response('Unauthorized', { status: 401 })

  // ─── Run access + permission check ─────────────────────────────────────────
  // Step 1: look up the run to get projectId (avoids IDOR)
  const runLookup = await db.run.findUnique({
    where: { id: runId },
    select: { project_id: true },
  })
  if (!runLookup) return new Response('Not Found', { status: 404 })

  const { project_id: projectId } = runLookup

  let run: { project_id: string }
  try {
    // Step 2: assert project membership
    await assertProjectAccess(caller, projectId)
    // Step 3: assert run belongs to that project
    run = await assertRunAccess(runId, projectId)
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
    async start(controller) {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null

      function sendRaw(data: string) {
        controller.enqueue(encoder.encode(data))
      }

      function send(event: RunSSEEvent, id?: string) {
        let data = ''
        if (id) data += `id: ${id}\n`
        data += `data: ${JSON.stringify(event)}\n\n`
        sendRaw(data)
      }

      function sendHeartbeat() {
        sendRaw(': heartbeat\n\n')
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

      // Initial state snapshot so client doesn't miss events that occurred
      // before the SSE connection was established
      try {
        const [runSnap, nodes] = await Promise.all([
          db.run.findUniqueOrThrow({ where: { id: runId } }),
          db.node.findMany({ where: { run_id: runId } }),
        ])
        send({ type: 'initial', run: runSnap, nodes } as unknown as RunSSEEvent)
      } catch { /* non-fatal — client will reconstruct from live events */ }

      // Replay reconnect buffer if Last-Event-ID header is present
      const lastEventId = req.headers.get('last-event-id')
      if (lastEventId) {
        try {
          const rows = await db.eventPayload.findMany({
            where: { run_id: runId, id: { gt: lastEventId } },
            orderBy: { created_at: 'asc' },
          })
          for (const row of rows) {
            try {
              const e = JSON.parse(row.payload) as RunSSEEvent
              if (shouldSendEvent(e)) send(e, row.id)
            } catch { /* skip malformed */ }
          }
        } catch { /* non-fatal */ }
      }

      // Subscribe to live events
      const unsubscribe = projectEventBus.subscribe(run.project_id, (e: ProjectEvent) => {
        if (e.run_id !== runId) return
        const sseEvent = e.event as RunSSEEvent
        if (!('type' in sseEvent)) return
        if (shouldSendEvent(sseEvent)) send(sseEvent)
      })

      // 30s heartbeat to keep connection alive through proxies (§34.4)
      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS)

      // Cleanup when client disconnects
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
