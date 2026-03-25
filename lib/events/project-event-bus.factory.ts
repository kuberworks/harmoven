// lib/events/project-event-bus.factory.ts
// Factory — selects the correct IProjectEventBus implementation at startup.
// Spec: TECHNICAL.md Section 29.2.
//
// Selection logic:
//   DEPLOYMENT_MODE=electron → InMemoryEventBus
//   (Restate: stub, not yet implemented)
//   default                  → PgNotifyEventBus (Docker)

import type { IProjectEventBus } from '@/lib/events/project-event-bus.interface'

function createProjectEventBus(): IProjectEventBus {
  if (process.env.DEPLOYMENT_MODE === 'electron' || process.env.NODE_ENV === 'test') {
    const { InMemoryEventBus } = require('@/lib/events/in-memory-event-bus')
    return new InMemoryEventBus()
  }
  const { PgNotifyEventBus } = require('@/lib/events/pg-notify-event-bus')
  return new PgNotifyEventBus()
}

// Singleton — one bus per process. Never call new PgNotifyEventBus() directly.
export const projectEventBus: IProjectEventBus = createProjectEventBus()
