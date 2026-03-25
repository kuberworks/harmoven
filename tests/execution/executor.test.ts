// tests/execution/executor.test.ts
// Unit tests for CustomExecutor — 5 DAG fixture scenarios.
// Uses InMemoryRunStore + MockAgentRunner — zero DB / network dependencies.

import { CustomExecutor } from '@/lib/execution/custom/executor'
import { InMemoryRunStore } from '@/tests/execution/store'
import type { AgentRunnerFn } from '@/lib/execution/engine.interface'
import type { Dag } from '@/types/dag.types'

import linearFixture  from './fixtures/linear.json'
import parallelFixture from './fixtures/parallel.json'
import branchingFixture from './fixtures/branching.json'
import failedFixture from './fixtures/failed.json'
import pausedFixture from './fixtures/paused.json'

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/**
 * Build an InMemoryRunStore seeded with a run + one node per DAG node.
 * All nodes start as PENDING.
 */
function buildStore(runId: string, dag: Dag): InMemoryRunStore {
  const store = new InMemoryRunStore()
  store.seedRun({
    id: runId,
    status: 'PENDING',
    dag,
    run_config: {},
    started_at: null,
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

/** Standard mock agent runner — completes successfully with a stub handoff. */
const happyRunner: AgentRunnerFn = async (node, _handoffIn, signal) => {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return {
    handoffOut: { from: node.node_id, result: 'ok' },
    costUsd: 0.001,
    tokensIn: 100,
    tokensOut: 50,
  }
}

/**
 * Failing agent runner — throws for nodes whose agent_type is WRITER
 * and config.shouldFail is true (used in 'failed' fixture).
 * All others succeed.
 */
const failingWriterRunner: AgentRunnerFn = async (node, handoffIn, signal) => {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  // The fixture marks n2 with config.shouldFail — we detect by agent_type WRITER
  if (node.agent_type === 'WRITER') {
    throw new Error('Simulated WRITER failure')
  }
  return happyRunner(node, handoffIn, signal)
}

/** Get final node statuses from the store. */
async function getNodeStatuses(store: InMemoryRunStore, runId: string) {
  const nodes = await store.node.findMany({ where: { run_id: runId } })
  return Object.fromEntries(nodes.map(n => [n.node_id, n.status]))
}

/** Get final run status. */
async function getRunStatus(store: InMemoryRunStore, runId: string) {
  const run = await store.run.findUniqueOrThrow({ where: { id: runId } })
  return run.status
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CustomExecutor', () => {
  // ── 1. Linear fixture ──────────────────────────────────────────────────────

  test('linear: n1 → n2 → n3 all COMPLETED, run COMPLETED', async () => {
    const runId = 'run-linear'
    const dag = linearFixture.dag as Dag
    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, happyRunner)

    await executor.executeRun(runId)

    const statuses = await getNodeStatuses(store, runId)
    expect(statuses['n1']).toBe('COMPLETED')
    expect(statuses['n2']).toBe('COMPLETED')
    expect(statuses['n3']).toBe('COMPLETED')
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })

  test('linear: each node executes in dependency order', async () => {
    const runId = 'run-linear-order'
    const dag = linearFixture.dag as Dag
    const completionOrder: string[] = []

    const orderTrackingRunner: AgentRunnerFn = async (node, handoffIn, signal) => {
      completionOrder.push(node.node_id)
      return happyRunner(node, handoffIn, signal)
    }

    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, orderTrackingRunner)

    await executor.executeRun(runId)

    // n1 must complete before n2, n2 before n3
    expect(completionOrder.indexOf('n1')).toBeLessThan(completionOrder.indexOf('n2'))
    expect(completionOrder.indexOf('n2')).toBeLessThan(completionOrder.indexOf('n3'))
  })

  // ── 2. Parallel fixture ────────────────────────────────────────────────────

  test('parallel: n2 and n3 run after n1, n4 runs after both, run COMPLETED', async () => {
    const runId = 'run-parallel'
    const dag = parallelFixture.dag as Dag
    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, happyRunner)

    await executor.executeRun(runId)

    const statuses = await getNodeStatuses(store, runId)
    expect(statuses['n1']).toBe('COMPLETED')
    expect(statuses['n2']).toBe('COMPLETED')
    expect(statuses['n3']).toBe('COMPLETED')
    expect(statuses['n4']).toBe('COMPLETED')
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })

  test('parallel: n2 and n3 both started before n4', async () => {
    const runId = 'run-parallel-order'
    const dag = parallelFixture.dag as Dag
    const startOrder: string[] = []

    const trackingRunner: AgentRunnerFn = async (node, handoffIn, signal) => {
      startOrder.push(node.node_id)
      return happyRunner(node, handoffIn, signal)
    }

    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, trackingRunner)

    await executor.executeRun(runId)

    // n1 first, then n2 and n3 (parallel), then n4
    expect(startOrder[0]).toBe('n1')
    expect(startOrder.slice(1, 3)).toEqual(expect.arrayContaining(['n2', 'n3']))
    expect(startOrder[3]).toBe('n4')
  })

  // ── 3. Branching fixture ───────────────────────────────────────────────────

  test('branching: all 5 nodes COMPLETED, run COMPLETED', async () => {
    const runId = 'run-branching'
    const dag = branchingFixture.dag as Dag
    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, happyRunner)

    await executor.executeRun(runId)

    const statuses = await getNodeStatuses(store, runId)
    expect(statuses['n1']).toBe('COMPLETED')
    expect(statuses['n2']).toBe('COMPLETED')
    expect(statuses['n3']).toBe('COMPLETED')
    expect(statuses['n4']).toBe('COMPLETED')
    expect(statuses['n5']).toBe('COMPLETED')
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })

  // ── 4. Failed fixture ──────────────────────────────────────────────────────

  test('failed: n1 COMPLETED, n2 FAILED, n3 stays PENDING, run FAILED', async () => {
    const runId = 'run-failed'
    const dag = failedFixture.dag as Dag
    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, failingWriterRunner)

    await executor.executeRun(runId)

    const statuses = await getNodeStatuses(store, runId)
    expect(statuses['n1']).toBe('COMPLETED')
    expect(statuses['n2']).toBe('FAILED')
    // n3 depends on n2 (FAILED) — never becomes READY, stays PENDING
    expect(statuses['n3']).toBe('PENDING')
    expect(await getRunStatus(store, runId)).toBe('FAILED')
  })

  test('failed: failed node records error message', async () => {
    const runId = 'run-failed-msg'
    const dag = failedFixture.dag as Dag
    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, failingWriterRunner)

    await executor.executeRun(runId)

    const nodes = await store.node.findMany({ where: { run_id: runId } })
    const failedNode = nodes.find(n => n.node_id === 'n2')
    expect(failedNode?.error).toBe('Simulated WRITER failure')
  })

  // ── 5. Paused fixture ──────────────────────────────────────────────────────

  test('paused: pauseRun transitions RUNNING→PAUSED, resumeRun completes the run', async () => {
    // Design: the executionLoop exits cleanly when it detects PAUSED.
    // resumeRun calls executeRun again from PAUSED status, which resumes execution.
    // COMPLETED nodes are not re-executed (getReadyNodes filters to PENDING only).

    const runId = 'run-paused'
    const dag = pausedFixture.dag as Dag
    const store = buildStore(runId, dag)

    // Manually advance to RUNNING to allow pauseRun()
    await store.run.update({ where: { id: runId }, data: { status: 'RUNNING', started_at: new Date() } })
    // Mark n1 as already COMPLETED (simulates mid-run state)
    const nodes = await store.node.findMany({ where: { run_id: runId } })
    const n1 = nodes.find(n => n.node_id === 'n1')!
    await store.node.update({ where: { id: n1.id }, data: { status: 'COMPLETED', completed_at: new Date(), handoff_out: { from: 'n1' } } })

    const executor = new CustomExecutor(store, happyRunner)

    // Pause the run
    await executor.pauseRun(runId, 'test-actor')
    expect(await getRunStatus(store, runId)).toBe('PAUSED')

    // Resume — this calls executeRun(PAUSED) which resumes from n2
    await executor.resumeRun(runId, 'test-actor')

    // All nodes should be complete
    const statuses = await getNodeStatuses(store, runId)
    expect(statuses['n1']).toBe('COMPLETED')   // COMPLETED before pause, not re-run
    expect(statuses['n2']).toBe('COMPLETED')
    expect(statuses['n3']).toBe('COMPLETED')
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })

  test('paused: run with all new nodes pauses and resumes from PENDING', async () => {
    const runId = 'run-paused-full'
    const dag = pausedFixture.dag as Dag
    const store = buildStore(runId, dag)

    // Manually advance to RUNNING
    await store.run.update({ where: { id: runId }, data: { status: 'RUNNING', started_at: new Date() } })

    const executor = new CustomExecutor(store, happyRunner)

    // Pause immediately (before any nodes run)
    await executor.pauseRun(runId, 'test-actor')
    expect(await getRunStatus(store, runId)).toBe('PAUSED')

    // Resume — runs all 3 nodes from scratch (all are PENDING)
    await executor.resumeRun(runId, 'test-actor')

    const statuses = await getNodeStatuses(store, runId)
    expect(statuses['n1']).toBe('COMPLETED')
    expect(statuses['n2']).toBe('COMPLETED')
    expect(statuses['n3']).toBe('COMPLETED')
    expect(await getRunStatus(store, runId)).toBe('COMPLETED')
  })

  // ── 6. cancelRun() ─────────────────────────────────────────────────────────

  test('cancelRun: aborts run in flight, run ends FAILED', async () => {
    const runId = 'run-cancel'
    const dag = linearFixture.dag as Dag
    const store = buildStore(runId, dag)

    const executor = new CustomExecutor(store, async (node, handoffIn, signal) => {
      // Simulate slow agent — cancel fires before it finishes
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500)
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) })
      })
      return happyRunner(node, handoffIn, signal)
    })

    // Start run, cancel after 30ms
    const runPromise = executor.executeRun(runId)
    setTimeout(() => executor.cancelRun(runId, 'test-actor'), 30)

    await runPromise

    expect(await getRunStatus(store, runId)).toBe('FAILED')
  })

  // ── 7. State machine — invalid transitions ─────────────────────────────────

  test('state-machine: cannot start a COMPLETED run', async () => {
    const runId = 'run-stateMachine'
    const dag = linearFixture.dag as Dag
    const store = buildStore(runId, dag)

    // Mark run as COMPLETED directly
    await store.run.update({ where: { id: runId }, data: { status: 'COMPLETED' } })

    const executor = new CustomExecutor(store, happyRunner)
    await expect(executor.executeRun(runId)).rejects.toThrow(/Cannot execute run/)
  })

  // ── 8. Audit log ───────────────────────────────────────────────────────────

  test('audit log: contains state_transition entries after run', async () => {
    const runId = 'run-audit'
    const dag = linearFixture.dag as Dag
    const store = buildStore(runId, dag)
    const executor = new CustomExecutor(store, happyRunner)

    await executor.executeRun(runId)

    const log = store.getAuditLog() as Array<{ action_type: string }>
    const transitions = log.filter(e => e.action_type === 'state_transition')
    expect(transitions.length).toBeGreaterThan(0)
  })
})
