// lib/events/pg-notify-event-bus.ts
// PgNotifyEventBus — PostgreSQL LISTEN/NOTIFY implementation.
// Used in: Docker deployments (default).
// Channel pattern: harmoven:project:{project_id}
// pg_notify payload limit: 8000 bytes — large events stored by ref in EventPayload.
// Spec: TECHNICAL.md Section 29.3.

import { Client } from 'pg'
import { EventEmitter } from 'node:events'
import type {
  IProjectEventBus,
  ProjectEvent,
  Unsubscribe,
} from '@/lib/events/project-event-bus.interface'

/** Maximum bytes we trust pg_notify to carry inline. 7900 leaves margin. */
const PG_NOTIFY_MAX_BYTES = 7900

/** Channel name for a given project. */
function channel(project_id: string): string {
  return `harmoven:project:${project_id}`
}

export class PgNotifyEventBus implements IProjectEventBus {
  private readonly emitter: EventEmitter
  /** Dedicated PG client for LISTEN — separate from Prisma pool. */
  private listener: Client | null = null
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
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    this.listener = client
    this._available = true

    client.on('notification', msg => {
      if (!msg.payload) return
      try {
        const event: ProjectEvent = JSON.parse(msg.payload)
        // Restore Date from ISO string
        event.emitted_at = new Date(event.emitted_at)
        const projectId = msg.channel.replace('harmoven:project:', '')
        this.emitter.emit(projectId, event)
      } catch {
        console.error('[PgNotifyEventBus] Failed to parse notification payload')
      }
    })

    client.on('error', err => {
      console.error('[PgNotifyEventBus] PG client error:', err)
      this._available = false
    })
  }

  async emit(event: ProjectEvent): Promise<void> {
    if (this._closed || !this.listener) return

    const payload = JSON.stringify(event)
    const byteLength = Buffer.byteLength(payload, 'utf8')

    if (byteLength > PG_NOTIFY_MAX_BYTES) {
      // Large event: store in EventPayload by ref, send a lightweight notice
      // Full persistence handled by the SSE route which reads EventPayload directly.
      // We still notify subscribers on the same process via the in-process emitter.
      this.emitter.emit(event.project_id, event)

      // pg_notify with a short ref for cross-process subscribers
      const ref = JSON.stringify({
        type: 'event_ref',
        project_id: event.project_id,
        run_id: event.run_id,
        event_type: (event.event as { type: string }).type,
        emitted_at: event.emitted_at,
      })
      await this.listener.query('SELECT pg_notify($1, $2)', [
        channel(event.project_id),
        ref,
      ])
    } else {
      await this.listener.query('SELECT pg_notify($1, $2)', [
        channel(event.project_id),
        payload,
      ])
    }
  }

  subscribe(project_id: string, handler: (e: ProjectEvent) => void): Unsubscribe {
    const count = (this.subscriberCount.get(project_id) ?? 0) + 1
    this.subscriberCount.set(project_id, count)

    if (count === 1 && this.listener) {
      // First subscriber for this project — start listening
      this.listener.query(`LISTEN "${channel(project_id)}"`)
        .catch(err => console.error('[PgNotifyEventBus] LISTEN error:', err))
    }

    this.emitter.on(project_id, handler)

    return () => {
      this.emitter.off(project_id, handler)
      const remaining = (this.subscriberCount.get(project_id) ?? 1) - 1
      this.subscriberCount.set(project_id, remaining)
      if (remaining === 0 && this.listener) {
        this.listener.query(`UNLISTEN "${channel(project_id)}"`)
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
      await this.listener.end()
      this.listener = null
    }
  }

  async isAvailable(): Promise<boolean> {
    return this._available && !this._closed
  }
}
