// app/api/runs/[runId]/stream/route.ts
// GET /api/runs/:runId/stream — SSE live event stream for a single run.
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
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return new Response(
    JSON.stringify({ error: 'Unauthorized' }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  )

  // ─── Run access + permission check ─────────────────────────────────────────
  // Step 1: look up the run to get projectId (avoids IDOR)
  const runLookup = await db.run.findUnique({
    where: { id: runId },
    select: { project_id: true },
  })
  if (!runLookup) return new Response(
    JSON.stringify({ error: 'Not Found' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  )

  const { project_id: projectId } = runLookup

  let run: { project_id: string }
  try {
    // Step 2: assert project membership
    await assertProjectAccess(caller, projectId)
    // Step 3: assert run belongs to that project
    run = await assertRunAccess(runId, projectId)
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

  const perms = await resolvePermissions(caller, run.project_id)
  if (!perms.has('stream:state')) {
    return new Response(
      JSON.stringify({ error: 'Forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
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

      // Subscribe to live events BEFORE querying the initial snapshot.
      // This closes the race condition where the executor emits `completed`
      // after we read the DB but before we subscribe — causing the event to be
      // lost and the client to stay frozen on RUNNING status indefinitely.
      //
      // Events that arrive during the initial DB query are buffered and flushed
      // immediately after `initial` is sent, so the client always sees them in
      // a consistent order (initial, then live updates).
      const pendingEvents: RunSSEEvent[] = []
      let initialSent = false

      const serializeCompletedRun = (sseEvent: RunSSEEvent): RunSSEEvent => {
        if (sseEvent.type !== 'completed' || !sseEvent.run) return sseEvent
        const r = sseEvent.run as Record<string, unknown>
        return {
          ...sseEvent,
          run: {
            ...r,
            cost_actual_usd: Number(r['cost_actual_usd'] ?? 0),
            budget_usd: r['budget_usd'] != null ? Number(r['budget_usd']) : null,
            started_at:   r['started_at']   instanceof Date ? (r['started_at'] as Date).toISOString()   : (r['started_at']   ?? null),
            completed_at: r['completed_at'] instanceof Date ? (r['completed_at'] as Date).toISOString() : (r['completed_at'] ?? null),
            paused_at:    r['paused_at']    instanceof Date ? (r['paused_at'] as Date).toISOString()    : (r['paused_at']    ?? null),
          },
        } as RunSSEEvent
      }

      const unsubscribe = projectEventBus.subscribe(run.project_id, (e: ProjectEvent) => {
        if (e.run_id !== runId) return
        let sseEvent = e.event as RunSSEEvent
        if (!('type' in sseEvent)) return
        sseEvent = serializeCompletedRun(sseEvent)
        if (!shouldSendEvent(sseEvent)) return
        if (!initialSent) {
          // Buffer until initial snapshot is sent so the client receives
          // events in causal order (initial always arrives first).
          pendingEvents.push(sseEvent)
        } else {
          send(sseEvent)
        }
      })

      // Initial state snapshot so client doesn't miss events that occurred
      // before the SSE connection was established
      try {
        const [runSnap, nodes] = await Promise.all([
          db.run.findUniqueOrThrow({ where: { id: runId } }),
          db.node.findMany({ where: { run_id: runId }, orderBy: { node_id: 'asc' } }),
        ])
        // Serialise Decimal fields to primitives — Prisma Decimal serialises as
        // a string via JSON.stringify, which breaks .toFixed() calls on the client.
        const serialisedRun = {
          ...runSnap,
          cost_actual_usd: Number(runSnap.cost_actual_usd),
          budget_usd: runSnap.budget_usd ? Number(runSnap.budget_usd) : null,
          started_at: runSnap.started_at?.toISOString() ?? null,
          completed_at: runSnap.completed_at?.toISOString() ?? null,
          paused_at: runSnap.paused_at?.toISOString() ?? null,
        }
        const serialisedNodes = nodes.map((n) => ({
          ...n,
          cost_usd: Number(n.cost_usd),
          started_at: n.started_at?.toISOString() ?? null,
          completed_at: n.completed_at?.toISOString() ?? null,
        }))
        send({ type: 'initial', run: serialisedRun, nodes: serialisedNodes } as unknown as RunSSEEvent)
      } catch { /* non-fatal — client will reconstruct from live events */ }

      // Flush buffered events (those received during the initial query)
      initialSent = true
      for (const e of pendingEvents) send(e)
      pendingEvents.length = 0

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
