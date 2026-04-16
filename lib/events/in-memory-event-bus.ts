// lib/events/in-memory-event-bus.ts
// InMemoryEventBus — Node.js EventEmitter-based implementation.
// Used in: unit tests, Electron single-user mode.
// No persistence — missed events on disconnect are NOT replayed.
// Spec: TECHNICAL.md Section 29.4.

import { EventEmitter } from 'node:events'
import type {
  IProjectEventBus,
  ProjectEvent,
  Unsubscribe,
} from '@/lib/events/project-event-bus.interface'

export class InMemoryEventBus implements IProjectEventBus {
  private readonly emitter: EventEmitter
  private _closed = false

  constructor() {
    this.emitter = new EventEmitter()
    // Prevent Node.js MaxListenersExceededWarning in tests with many subscribers
    this.emitter.setMaxListeners(100)
  }

  async emit(event: ProjectEvent): Promise<void> {
    if (this._closed) return
    this.emitter.emit(event.project_id, event)
  }

  subscribe(project_id: string, handler: (e: ProjectEvent) => void): Unsubscribe {
    this.emitter.on(project_id, handler)
    return () => {
      this.emitter.off(project_id, handler)
    }
  }

  async close(): Promise<void> {
    this._closed = true
    this.emitter.removeAllListeners()
  }

  async isAvailable(): Promise<boolean> {
    return !this._closed
  }
}
