// lib/events/pg-notify-event-bus.ts
// PgNotifyEventBus — PostgreSQL LISTEN/NOTIFY implementation.
// Used in: Docker deployments (default).
// Channel pattern: harmoven:project:{project_id}
// pg_notify payload limit: 8000 bytes — large events stored in EventPayload.
// Spec: TECHNICAL.md Section 29.3.
//
// Security:
//   project_id is validated as UUID v4 before use in LISTEN/UNLISTEN
//   to prevent SQL injection via channel name (Section 24).
//
// Reliability:
//   - Auto-reconnects on PG client error (after 5s backoff).
//   - All events written to EventPayload table for reconnect replay buffer.
//   - Large events: full payload in EventPayload; short ref via pg_notify.
//   - event_ref subscribers resolve by reading EventPayload.

import { Client } from 'pg'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  IProjectEventBus,
  ProjectEvent,
  Unsubscribe,
} from '@/lib/events/project-event-bus.interface'

/** Maximum bytes we trust pg_notify to carry inline. 7900 leaves margin. */
const PG_NOTIFY_MAX_BYTES = 7900
/** EventPayload TTL in hours (24h reconnect buffer). */
const EVENT_PAYLOAD_TTL_HOURS = 24
/** Reconnect backoff after PG error. */
const RECONNECT_DELAY_MS = 5_000

/** Validates that a string is a UUID v4 — used to guard LISTEN channel names. */
function assertUuidProjectId(project_id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(project_id)) {
    throw new Error(`[PgNotifyEventBus] project_id "${project_id}" is not a valid UUID v4`)
  }
}

/** Channel name for a given project. Project id already validated. */
function channel(project_id: string): string {
  return `harmoven:project:${project_id}`
}

export class PgNotifyEventBus implements IProjectEventBus {
  private readonly emitter: EventEmitter
  /** Dedicated PG client for LISTEN — separate from Prisma pool. */
  private listener: Client | null = null
  /** Separate PG client for emit queries (INSERT + pg_notify). */
  private emitter_client: Client | null = null
  /** ref-count of subscribers per project_id — UNLISTEN when count hits 0. */
  private subscriberCount = new Map<string, number>()
  private _closed = false
  private _available = false

  constructor() {
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(200)
    this.initListener().catch(err => {
      console.error('[PgNotifyEventBus] Failed to connect listener:', err)
    })
  }

  private async initListener(): Promise<void> {
    if (this._closed) return
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    const emitClient = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    await emitClient.connect()
    this.listener = client
    this.emitter_client = emitClient
    this._available = true

    // Re-subscribe to all active channels after reconnect
    for (const project_id of this.subscriberCount.keys()) {
      await client.query('LISTEN $1', [channel(project_id)]).catch(() => {})
    }

    client.on('notification', async msg => {
      if (!msg.payload) return
      try {
        const raw = JSON.parse(msg.payload) as Record<string, unknown>
        const projectId = msg.channel.replace('harmoven:project:', '')

        if (raw['type'] === 'event_ref') {
          // Large event: fetch full payload from EventPayload table
          const refId = raw['event_payload_id'] as string | undefined
          if (!refId) return
          const res = await emitClient.query<{ payload: string }>(
            'SELECT payload FROM "EventPayload" WHERE id = $1',
            [refId],
          )
          if (res.rows.length === 0) return
          const row = res.rows[0]
          if (!row) return
          const event = JSON.parse(row.payload) as ProjectEvent
          event.emitted_at = new Date(event.emitted_at)
          this.emitter.emit(projectId, event)
        } else {
          const event = raw as unknown as ProjectEvent
          event.emitted_at = new Date(event.emitted_at as unknown as string)
          this.emitter.emit(projectId, event)
        }
      } catch (err) {
        console.error('[PgNotifyEventBus] Failed to handle notification', err)
      }
    })

    client.on('error', err => {
      console.error('[PgNotifyEventBus] PG client error — reconnecting in 5s:', err)
      this._available = false
      this.listener = null
      this.emitter_client = null
      if (!this._closed) {
        setTimeout(() => {
          this.initListener().catch(e =>
            console.error('[PgNotifyEventBus] Reconnect failed:', e),
          )
        }, RECONNECT_DELAY_MS)
      }
    })
  }

  async emit(event: ProjectEvent): Promise<void> {
    if (this._closed) return

    const fullPayload = JSON.stringify(event)
    const byteLength = Buffer.byteLength(fullPayload, 'utf8')
    const expiresAt = new Date(Date.now() + EVENT_PAYLOAD_TTL_HOURS * 3600_000)

    // Always persist to EventPayload for the reconnect replay buffer
    const payloadId = randomUUID()
    if (this.emitter_client) {
      await this.emitter_client.query(
        'INSERT INTO "EventPayload" (id, project_id, run_id, payload, created_at, expires_at) VALUES ($1, $2, $3, $4, NOW(), $5)',
        [payloadId, event.project_id, event.run_id, fullPayload, expiresAt],
      ).catch(err => console.error('[PgNotifyEventBus] EventPayload insert failed:', err))
    }

    // Also deliver in-process immediately
    this.emitter.emit(event.project_id, event)

    if (!this.listener) return

    if (byteLength > PG_NOTIFY_MAX_BYTES) {
      // Large event: cross-process ref points to EventPayload row
      const ref = JSON.stringify({
        type: 'event_ref',
        event_payload_id: payloadId,
        project_id: event.project_id,
        run_id: event.run_id,
      })
      await this.listener.query('SELECT pg_notify($1, $2)', [
        channel(event.project_id),
        ref,
      ])
    } else {
      await this.listener.query('SELECT pg_notify($1, $2)', [
        channel(event.project_id),
        fullPayload,
      ])
    }
  }

  subscribe(project_id: string, handler: (e: ProjectEvent) => void): Unsubscribe {
    // Guard: project_id must be UUID v4 before use in SQL LISTEN
    assertUuidProjectId(project_id)

    const count = (this.subscriberCount.get(project_id) ?? 0) + 1
    this.subscriberCount.set(project_id, count)

    if (count === 1 && this.listener) {
      // First subscriber for this project — start listening
      this.listener.query('LISTEN $1', [channel(project_id)])
        .catch(err => console.error('[PgNotifyEventBus] LISTEN error:', err))
    }

    this.emitter.on(project_id, handler)

    return () => {
      this.emitter.off(project_id, handler)
      const remaining = (this.subscriberCount.get(project_id) ?? 1) - 1
      this.subscriberCount.set(project_id, remaining)
      if (remaining === 0 && this.listener) {
        this.listener.query('UNLISTEN $1', [channel(project_id)])
          .catch(err => console.error('[PgNotifyEventBus] UNLISTEN error:', err))
        this.subscriberCount.delete(project_id)
      }
    }
  }

  async close(): Promise<void> {
    this._closed = true
    this._available = false
    this.emitter.removeAllListeners()
    if (this.listener) {
      await this.listener.end().catch(() => {})
      this.listener = null
    }
    if (this.emitter_client) {
      await this.emitter_client.end().catch(() => {})
      this.emitter_client = null
    }
  }

  async isAvailable(): Promise<boolean> {
    return this._available && !this._closed
  }
}
