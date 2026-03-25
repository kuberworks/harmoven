// tests/events/event-bus.test.ts
// Integration test for IProjectEventBus — InMemoryEventBus.
// Spec: TECHNICAL.md Section 29, Amendment 79.
// Done when: client receives state_change event.

import { InMemoryEventBus } from '@/lib/events/in-memory-event-bus'
import type { ProjectEvent, RunSSEEvent } from '@/lib/events/project-event-bus.interface'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStateChangeEvent(
  project_id: string,
  run_id: string,
  entity_id: string,
  status: string,
): ProjectEvent {
  return {
    project_id,
    run_id,
    event: {
      type: 'state_change',
      entity_type: 'node',
      id: entity_id,
      status,
    } satisfies RunSSEEvent,
    emitted_at: new Date(),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InMemoryEventBus', () => {
  it('delivers a state_change event to a subscriber', async () => {
    const bus = new InMemoryEventBus()
    const received: ProjectEvent[] = []

    const unsubscribe = bus.subscribe('proj-1', e => received.push(e))
    await bus.emit(makeStateChangeEvent('proj-1', 'run-1', 'n1', 'RUNNING'))

    expect(received).toHaveLength(1)
    const evt = received[0]
    expect(evt.project_id).toBe('proj-1')
    expect(evt.run_id).toBe('run-1')
    expect((evt.event as RunSSEEvent & { type: 'state_change' }).type).toBe('state_change')
    expect((evt.event as RunSSEEvent & { type: 'state_change' }).status).toBe('RUNNING')

    unsubscribe()
    await bus.close()
  })

  it('does not deliver events after unsubscribe', async () => {
    const bus = new InMemoryEventBus()
    const received: ProjectEvent[] = []

    const unsubscribe = bus.subscribe('proj-2', e => received.push(e))
    await bus.emit(makeStateChangeEvent('proj-2', 'run-2', 'n1', 'RUNNING'))
    unsubscribe()
    await bus.emit(makeStateChangeEvent('proj-2', 'run-2', 'n1', 'COMPLETED'))

    expect(received).toHaveLength(1)
    expect((received[0].event as { status: string }).status).toBe('RUNNING')

    await bus.close()
  })

  it('delivers to multiple subscribers for the same project', async () => {
    const bus = new InMemoryEventBus()
    const receivedA: ProjectEvent[] = []
    const receivedB: ProjectEvent[] = []

    const unsubA = bus.subscribe('proj-3', e => receivedA.push(e))
    const unsubB = bus.subscribe('proj-3', e => receivedB.push(e))
    await bus.emit(makeStateChangeEvent('proj-3', 'run-3', 'n1', 'COMPLETED'))

    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(1)

    unsubA()
    unsubB()
    await bus.close()
  })

  it('isolates events by project — different project_id does not receive', async () => {
    const bus = new InMemoryEventBus()
    const receivedForProjA: ProjectEvent[] = []

    const unsubscribe = bus.subscribe('proj-A', e => receivedForProjA.push(e))
    // Emit to proj-B only
    await bus.emit(makeStateChangeEvent('proj-B', 'run-B', 'n1', 'RUNNING'))

    expect(receivedForProjA).toHaveLength(0)

    unsubscribe()
    await bus.close()
  })

  it('no-ops after close', async () => {
    const bus = new InMemoryEventBus()
    const received: ProjectEvent[] = []

    bus.subscribe('proj-4', e => received.push(e))
    await bus.close()
    await bus.emit(makeStateChangeEvent('proj-4', 'run-4', 'n1', 'RUNNING'))

    // After close(), emit is a no-op — no error thrown, nothing received
    expect(received).toHaveLength(0)
  })

  it('isAvailable returns true before close and false after', async () => {
    const bus = new InMemoryEventBus()
    expect(await bus.isAvailable()).toBe(true)
    await bus.close()
    expect(await bus.isAvailable()).toBe(false)
  })

  it('handles multiple emits with correct ordering', async () => {
    const bus = new InMemoryEventBus()
    const statuses: string[] = []

    const unsubscribe = bus.subscribe('proj-5', e => {
      statuses.push((e.event as { status: string }).status)
    })

    await bus.emit(makeStateChangeEvent('proj-5', 'run-5', 'n1', 'PENDING'))
    await bus.emit(makeStateChangeEvent('proj-5', 'run-5', 'n1', 'RUNNING'))
    await bus.emit(makeStateChangeEvent('proj-5', 'run-5', 'n1', 'COMPLETED'))

    expect(statuses).toEqual(['PENDING', 'RUNNING', 'COMPLETED'])

    unsubscribe()
    await bus.close()
  })
})
