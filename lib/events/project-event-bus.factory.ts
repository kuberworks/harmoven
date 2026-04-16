// lib/events/project-event-bus.factory.ts
// Factory — selects the correct IProjectEventBus implementation at startup.
// Spec: TECHNICAL.md Section 29.2.
//
// Selection logic:
//   DEPLOYMENT_MODE=electron → InMemoryEventBus
//   NODE_ENV=test            → InMemoryEventBus
//   default                  → PgNotifyEventBus (Docker)
//
// Hot-reload guard: the singleton is stored on globalThis so Next.js HMR
// does not create a new PgNotifyEventBus (and orphan PG connections) on
// every module reload in development.

import type { IProjectEventBus } from '@/lib/events/project-event-bus.interface'
import { InMemoryEventBus } from '@/lib/events/in-memory-event-bus'
import { PgNotifyEventBus } from '@/lib/events/pg-notify-event-bus'

declare global {
  // eslint-disable-next-line no-var
  var __harmoven_event_bus__: IProjectEventBus | undefined
}

function createProjectEventBus(): IProjectEventBus {
  if (process.env.DEPLOYMENT_MODE === 'electron' || process.env.NODE_ENV === 'test') {
    return new InMemoryEventBus()
  }
  return new PgNotifyEventBus()
}

// In development: reuse the existing bus across HMR reloads to avoid
// leaking PG listener connections. In production there is only one module
// load so the condition is always false and we create it fresh.
if (!global.__harmoven_event_bus__) {
  global.__harmoven_event_bus__ = createProjectEventBus()
}

export const projectEventBus: IProjectEventBus = global.__harmoven_event_bus__
