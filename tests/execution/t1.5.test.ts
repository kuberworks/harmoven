// tests/execution/t1.5.test.ts
// T1.5 unit tests: HeartbeatManager, MAX_CONCURRENT_NODES, orphan recovery, shutdown protocol.
// All tests are zero-DB / zero-network (InMemoryRunStore + synthetic AgentRunnerFn).

import { CustomExecutor, InMemoryRunStore } from '@/lib/execution/custom/executor'
import { HeartbeatManager } from '@/lib/execution/custom/heartbeat'
import type { AgentRunnerFn } from '@/lib/execution/engine.interface'
import type { Dag } from '@/types/dag.types'

import wideParallelFixture from './fixtures/wide-parallel.json'
import linearFixture       from './fixtures/linear.json'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildStore(runId: string, dag: Dag, status = 'PENDING'): InMemoryRunStore {
  const store = new InMemoryRunStore()
  store.seedRun({
    id: runId,
    status,
    dag,
    run_config: {},
    started_at: status !== 'PENDING' ? new Date() : null,
    completed_at: null,
    paused_at: null,
    metadata: {},
  })
  for (const dagNode of dag.nodes) {
    store.seedNode(runId, {
      run_id: runId,
      node_id: dagNode.id,
      agent_type: dagNode.agent_type,
      status: 'PENDING',
      started_at: null,
      completed_at: null,
      interrupted_at: null,
      interrupted_by: null,
      last_heartbeat: null,
      retries: 0,
      handoff_in: null,
      handoff_out: null,
      partial_output: null,
      partial_updated_at: null,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      error: null,
      metadata: {},
    })
  }
  return store
}

const happyRunner: AgentRunnerFn = async (node, _handoffIn, signal) => {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return { handoffOut: { from: node.node_id }, costUsd: 0, tokensIn: 0, tokensOut: 0 }
}

async function getRunStatus(store: InMemoryRunStore, runId: string): Promise<string> {
  const run = await store.run.findUniqueOrThrow({ where: { id: runId } })
  return run.status
}

async function getNodeStatuses(store: InMemoryRunStore, runId: string) {
  const nodes = await store.node.findMany({ where: { run_id: runId } })
  return Object.fromEntries(nodes.map(n => [n.node_id, n.status]))
}

/** Polls until `cond` resolves to true or the timeout elapses. */
async function waitUntil(
  cond: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise<void>(r => setTimeout(r, 5))
  }
  throw new Error('waitUntil: condition not met within timeout')
}

// ─── HeartbeatManager ────────────────────────────────────────────────────────

describe('HeartbeatManager', () => {
  test('pulse is called after interval elapses', async () => {
    const hb = new HeartbeatManager()
    let pulsed = 0

    hb.start('n1', async () => { pulsed++ }, 10)  // 10 ms interval

    // Wait ~3 intervals
    await new Promise<void>(r => setTimeout(r, 40))
    hb.stop('n1')

    expect(pulsed).toBeGreaterThanOrEqual(2)
  })

  test('stop cancels the interval — no further pulses', async () => {
    const hb = new HeartbeatManager()
    let pulsed = 0

    hb.start('n1', async () => { pulsed++ }, 10)
    hb.stop('n1')

    await new Promise<void>(r => setTimeout(r, 40))
    expect(pulsed).toBe(0)
  })

  test('stopAll clears every timer', async () => {
    const hb = new HeartbeatManager()
    let count = 0

    hb.start('n1', async () => { count++ }, 20)
    hb.start('n2', async () => { count++ }, 20)
    hb.start('n3', async () => { count++ }, 20)

    expect(hb.activeCount).toBe(3)
    hb.stopAll()
    expect(hb.activeCount).toBe(0)

    // Confirm no pulses fired after stopAll
    await new Promise<void>(r => setTimeout(r, 50))
    expect(count).toBe(0)
  })

  test('duplicate start for same nodeId is a no-op (only one timer)', async () => {
    const hb = new HeartbeatManager()
    let pulsed = 0

    hb.start('n1', async () => { pulsed++ }, 10)
    hb.start('n1', async () => { pulsed++ }, 10)  // duplicate

    expect(hb.activeCount).toBe(1)
    hb.stop('n1')
  })
})

// ─── MAX_CONCURRENT_NODES ─────────────────────────────────────────────────────

describe('MAX_CONCURRENT_NODES', () => {
  test('caps concurrent nodes at maxConcurrentNodes=2 across 6 independent nodes', async () => {
    const runId = 'run-wide'
    const dag = wideParallelFixture.dag as Dag
    const store = buildStore(runId, dag)

    let concurrent = 0
    let maxObserved = 0

    const trackingRunner: AgentRunnerFn = async (node, _handoffIn, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      concurrent++
      maxObserved = Math.max(maxObserved, concurrent)
      // Small delay so all nodes in the batch start before any one finishes.
      await new Promise<void>(r => setTimeout(r, 5))
      concurrent--
      return { handoffOut: { from: node.node_id }, costUsd: 0, tokensIn: 0, tokensOut: 0 }
    }

    const executor = new CustomExecutor(store, trackingRunner, 2)
    await executor.executeRun(runId)

    // Max observed concurrency must respect the cap
    expect(maxObserved).toBe(2)

    // All 6 nodes must still complete
    const statuses = await getNodeStatuses(store, runId)
    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) {
      expect(statuses[id]).toBe('COMPLETED')
    }
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })

  test('cap=1 executes all nodes sequentially', async () => {
    const runId = 'run-serial'
    const dag = wideParallelFixture.dag as Dag
    const store = buildStore(runId, dag)

    let peak = 0
    let active = 0

    const trackingRunner: AgentRunnerFn = async (node, _handoffIn, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      active++
      peak = Math.max(peak, active)
      await new Promise<void>(r => setTimeout(r, 2))
      active--
      return { handoffOut: {}, costUsd: 0, tokensIn: 0, tokensOut: 0 }
    }

    const executor = new CustomExecutor(store, trackingRunner, 1)
    await executor.executeRun(runId)

    expect(peak).toBe(1)
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })

  test('cap larger than ready nodes runs all available nodes at once', async () => {
    // parallel.json: n1→{n2,n3}→n4 — max 2 run at once (n2+n3)
    const importedFixture = require('./fixtures/parallel.json') as { dag: Dag }
    const runId = 'run-cap-large'
    const store = buildStore(runId, importedFixture.dag)

    let peak = 0
    let active = 0

    const trackingRunner: AgentRunnerFn = async (node, _handoffIn, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      active++
      peak = Math.max(peak, active)
      await new Promise<void>(r => setTimeout(r, 5))
      active--
      return { handoffOut: {}, costUsd: 0, tokensIn: 0, tokensOut: 0 }
    }

    // cap=10 — much larger than the 2 nodes that can run at once
    const executor = new CustomExecutor(store, trackingRunner, 10)
    await executor.executeRun(runId)

    // n2 and n3 run in parallel — peak should be 2
    expect(peak).toBe(2)
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })
})

// ─── Orphan Recovery ─────────────────────────────────────────────────────────

describe('recoverOrphans', () => {
  test('marks stale RUNNING nodes INTERRUPTED and suspends the run', async () => {
    const store = new InMemoryRunStore()
    const runId = 'run-orphan'

    const staleDate = new Date(Date.now() - 120_000)  // 2 min ago

    store.seedRun({
      id: runId,
      status: 'RUNNING',
      dag: { nodes: [{ id: 'n1', agent_type: 'WRITER' }], edges: [] },
      run_config: {},
      started_at: staleDate,
      completed_at: null,
      paused_at: null,
      metadata: {},
    })
    store.seedNode(runId, {
      run_id: runId,
      node_id: 'n1',
      agent_type: 'WRITER',
      status: 'RUNNING',          // stuck in RUNNING
      started_at: staleDate,
      completed_at: null,
      interrupted_at: null,
      interrupted_by: null,
      last_heartbeat: staleDate,  // no pulse for 2 min
      retries: 0,
      handoff_in: null,
      handoff_out: null,
      partial_output: null,
      partial_updated_at: null,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      error: null,
      metadata: {},
    })

    const executor = new CustomExecutor(store, happyRunner)

    // threshold = 60 s → 2-min-old heartbeat is stale
    const { recovered } = await executor.recoverOrphans(60_000)

    expect(recovered).toBe(1)

    const nodes = await store.node.findMany({ where: { run_id: runId } })
    const n1 = nodes[0]!
    expect(n1.status).toBe('INTERRUPTED')
    expect(n1.interrupted_by).toBe('orphan_detection')

    expect(await getRunStatus(store, runId)).toBe('SUSPENDED')
  })

  test('ignores nodes with a fresh heartbeat', async () => {
    const store = new InMemoryRunStore()
    const runId = 'run-fresh'

    store.seedRun({
      id: runId,
      status: 'RUNNING',
      dag: { nodes: [{ id: 'n1', agent_type: 'WRITER' }], edges: [] },
      run_config: {}, started_at: new Date(), completed_at: null, paused_at: null, metadata: {},
    })
    store.seedNode(runId, {
      run_id: runId,
      node_id: 'n1',
      agent_type: 'WRITER',
      status: 'RUNNING',
      started_at: new Date(),
      completed_at: null,
      interrupted_at: null,
      interrupted_by: null,
      last_heartbeat: new Date(),  // fresh — just pulsed
      retries: 0,
      handoff_in: null,
      handoff_out: null,
      partial_output: null,
      partial_updated_at: null,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      error: null,
      metadata: {},
    })

    const executor = new CustomExecutor(store, happyRunner)
    const { recovered } = await executor.recoverOrphans(60_000)

    expect(recovered).toBe(0)
    expect(await getRunStatus(store, runId)).toBe('RUNNING')  // unchanged
  })

  test('ignores RUNNING nodes with null last_heartbeat (never started pulsing)', async () => {
    // last_heartbeat can be null if the process crashed before the first pulse.
    // The spec only transitions nodes that HAVE a stale heartbeat.
    const store = new InMemoryRunStore()
    const runId = 'run-null-hb'

    store.seedRun({
      id: runId,
      status: 'RUNNING',
      dag: { nodes: [{ id: 'n1', agent_type: 'WRITER' }], edges: [] },
      run_config: {}, started_at: new Date(), completed_at: null, paused_at: null, metadata: {},
    })
    store.seedNode(runId, {
      run_id: runId,
      node_id: 'n1',
      agent_type: 'WRITER',
      status: 'RUNNING',
      started_at: new Date(),
      completed_at: null,
      interrupted_at: null,
      interrupted_by: null,
      last_heartbeat: null,  // null — no heartbeat yet
      retries: 0,
      handoff_in: null,
      handoff_out: null,
      partial_output: null,
      partial_updated_at: null,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      error: null,
      metadata: {},
    })

    const executor = new CustomExecutor(store, happyRunner)
    const { recovered } = await executor.recoverOrphans(60_000)

    expect(recovered).toBe(0)
  })
})

// ─── Shutdown Protocol ───────────────────────────────────────────────────────

describe('shutdown protocol', () => {
  test('markShutdownNodes marks in-flight nodes INTERRUPTED and suspendInterruptedRuns suspends the run', async () => {
    const runId = 'run-shutdown'
    const dag = linearFixture.dag as Dag
    const store = buildStore(runId, dag)

    let resolveBarrier!: () => void
    const barrier = new Promise<void>(r => { resolveBarrier = r })

    const slowRunner: AgentRunnerFn = async (_node, _handoffIn, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await barrier  // holds until released
      return { handoffOut: {}, costUsd: 0, tokensIn: 0, tokensOut: 0 }
    }

    const executor = new CustomExecutor(store, slowRunner)

    // Start the run without awaiting — it will block on barrier
    const runPromise = executor.executeRun(runId).catch(() => { /* state-machine error expected after release */ })

    // Wait until n1 is RUNNING
    await waitUntil(async () => {
      const ns = await store.node.findMany({ where: { run_id: runId } })
      return ns.some(n => n.status === 'RUNNING')
    })

    expect(executor.hasRunningNodes()).toBe(true)

    // Simulate SIGTERM: mark nodes + suspend runs
    await executor.markShutdownNodes()
    await executor.suspendInterruptedRuns('shutdown_test')

    // Assertions BEFORE releasing the barrier (state is clean here)
    const nodes = await store.node.findMany({ where: { run_id: runId } })
    expect(nodes.some(n => n.status === 'INTERRUPTED')).toBe(true)
    expect(await getRunStatus(store, runId)).toBe('SUSPENDED')
    expect(executor.hasRunningNodes()).toBe(false)

    // Release the barrier — the dangling executeNode will fail gracefully
    resolveBarrier()
    await runPromise
  })

  test('stopAcceptingRuns prevents new executeRun calls', async () => {
    const runId = 'run-blocked'
    const dag = linearFixture.dag as Dag
    const store = buildStore(runId, dag)

    const executor = new CustomExecutor(store, happyRunner)
    executor.stopAcceptingRuns()

    expect(executor.isShuttingDown()).toBe(true)
    await expect(executor.executeRun(runId)).rejects.toThrow('shutting down')
  })
})
