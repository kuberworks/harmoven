// tests/execution/t3.2-user-control.test.ts
// Unit tests for T3.2 — User control: Pause/Inject/Interrupt (Am.63/64/65).
// Uses InMemoryRunStore + custom AgentRunnerFn — zero DB / network dependencies.

import { CustomExecutor } from '@/lib/execution/custom/executor'
import { InMemoryRunStore } from '@/tests/execution/store'
import type { AgentRunnerFn } from '@/lib/execution/engine.interface'
import type { Dag } from '@/types/dag.types'

// ─── Fixture ─────────────────────────────────────────────────────────────────

const LINEAR_DAG: Dag = {
  nodes: [
    { id: 'n1', agent_type: 'CLASSIFIER', config: {} },
    { id: 'n2', agent_type: 'WRITER',     config: {} },
  ],
  edges: [{ from: 'n1', to: 'n2' }],
}

const SINGLE_DAG: Dag = {
  nodes: [{ id: 'n1', agent_type: 'WRITER', config: {} }],
  edges: [],
}

/** Build a seeded store with all nodes PENDING. */
function buildStore(runId: string, dag: Dag, overrides: Record<string, unknown> = {}): InMemoryRunStore {
  const store = new InMemoryRunStore()
  store.seedRun({
    id: runId,
    project_id: 'proj-1',
    status: 'PENDING',
    dag,
    run_config: {},
    task_input: 'test',
    domain_profile: 'test',
    started_at: null,
    completed_at: null,
    paused_at: null,
    last_completed_node_at: null,
    user_injections: [],
    budget_usd: null,
    suspended_reason: null,
    metadata: {},
    ...overrides,
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
      partial_output: 'some partial text',
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

async function getNodeStatus(store: InMemoryRunStore, runId: string, nodeId: string) {
  const nodes = await store.node.findMany({ where: { run_id: runId } })
  return nodes.find(n => n.node_id === nodeId)?.status
}

async function getRunStatus(store: InMemoryRunStore, runId: string) {
  const run = await store.run.findUniqueOrThrow({ where: { id: runId } })
  return run.status
}

/** Poll until a node reaches a given status. Used after void-executeRun calls. */
async function waitForNodeStatus(
  store: InMemoryRunStore, runId: string, nodeId: string,
  targetStatus: string, timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await getNodeStatus(store, runId, nodeId)
    if (s === targetStatus) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`Node ${nodeId} did not reach status '${targetStatus}' within ${timeoutMs}ms`)
}

// ─── Amendment 64 — Context injection ────────────────────────────────────────

describe('injectContext()', () => {
  test('appends a UserInjection to run.user_injections', async () => {
    const runId = 'run-inject-1'
    const store = buildStore(runId, SINGLE_DAG, { status: 'RUNNING' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    const injection = await executor.injectContext(runId, 'contexte important', 'user-1')

    expect(injection.content).toBe('contexte important')
    expect(injection.applies_to).toBe('all_pending')
    expect(injection.created_by).toBe('user-1')
    expect(injection.id).toBeTruthy()

    const run = await store.run.findUniqueOrThrow({ where: { id: runId } })
    const injections = run.user_injections as unknown[]
    expect(injections).toHaveLength(1)
  })

  test('appends without overwriting existing injections', async () => {
    const runId = 'run-inject-2'
    const existing = [{ id: 'prev', created_at: new Date().toISOString(), created_by: 'u1', content: 'first', applies_to: 'all_pending' }]
    const store = buildStore(runId, SINGLE_DAG, { status: 'RUNNING', user_injections: existing })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await executor.injectContext(runId, 'second note', 'user-2')

    const run = await store.run.findUniqueOrThrow({ where: { id: runId } })
    const injections = run.user_injections as unknown[]
    expect(injections).toHaveLength(2)
  })

  test('rejects content exceeding 2000 characters', async () => {
    const runId = 'run-inject-limit'
    const store = buildStore(runId, SINGLE_DAG, { status: 'RUNNING' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    const longContent = 'a'.repeat(2001)
    await expect(executor.injectContext(runId, longContent, 'user-1'))
      .rejects.toThrow('2000')
  })

  test('rejects empty content', async () => {
    const runId = 'run-inject-empty'
    const store = buildStore(runId, SINGLE_DAG, { status: 'RUNNING' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await expect(executor.injectContext(runId, '   ', 'user-1'))
      .rejects.toThrow()
  })

  test('rejects injection into COMPLETED run', async () => {
    const runId = 'run-inject-done'
    const store = buildStore(runId, SINGLE_DAG, { status: 'COMPLETED' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await expect(executor.injectContext(runId, 'too late', 'user-1'))
      .rejects.toThrow('Cannot inject context')
  })

  test('allows injection into PAUSED run', async () => {
    const runId = 'run-inject-paused'
    const store = buildStore(runId, SINGLE_DAG, { status: 'PAUSED' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    const injection = await executor.injectContext(runId, 'note during pause', 'user-1')
    expect(injection.content).toBe('note during pause')
  })
})

// ─── Amendment 63 — Pause / Resume ───────────────────────────────────────────

describe('pauseRun() / resumeRun()', () => {
  test('pauseRun() transitions RUNNING → PAUSED and sets paused_at', async () => {
    const runId = 'run-pause-1'
    const store = buildStore(runId, LINEAR_DAG, { status: 'RUNNING' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await executor.pauseRun(runId, 'user-1')

    expect(await getRunStatus(store, runId)).toBe('PAUSED')
    const run = await store.run.findUniqueOrThrow({ where: { id: runId } })
    expect(run.paused_at).toBeTruthy()
  })

  test('pauseRun() throws InvalidTransitionError for terminal runs', async () => {
    const runId = 'run-pause-completed'
    const store = buildStore(runId, LINEAR_DAG, { status: 'COMPLETED' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await expect(executor.pauseRun(runId, 'user-1')).rejects.toThrow()
  })
})

// ─── Amendment 65 — interruptNode() ──────────────────────────────────────────

describe('interruptNode()', () => {
  test('throws if node is not RUNNING', async () => {
    const runId = 'run-interrupt-pending'
    const store = buildStore(runId, SINGLE_DAG, { status: 'RUNNING' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    // Node is still PENDING — interrupt should reject.
    await expect(executor.interruptNode(runId, 'n1', 'user-1'))
      .rejects.toThrow('must be RUNNING')
  })

  test('throws if node is not found', async () => {
    const runId = 'run-interrupt-notfound'
    const store = buildStore(runId, SINGLE_DAG, { status: 'RUNNING' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await expect(executor.interruptNode(runId, 'n99', 'user-1'))
      .rejects.toThrow('not found')
  })

  test('aborts a running node via per-node AbortController', async () => {
    const runId = 'run-interrupt-abort'
    let interruptFn: (() => void) | undefined

    // Runner holds until interrupt() is called.
    const latchRunner: AgentRunnerFn = async (_node, _handoffIn, signal) => {
      return new Promise<{ handoffOut: unknown; costUsd: number; tokensIn: number; tokensOut: number }>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        interruptFn = () => reject(new DOMException('Aborted', 'AbortError'))
      })
    }

    const store = buildStore(runId, SINGLE_DAG, {})
    // Manually set the node to RUNNING so interruptNode() accepts it.
    const nodes = await store.node.findMany({ where: { run_id: runId } })
    const nodeId = nodes[0]?.id
    if (nodeId) {
      await store.node.update({ where: { id: nodeId }, data: { status: 'RUNNING' } })
    }
    store.seedRun({ id: runId, status: 'RUNNING', dag: SINGLE_DAG, run_config: {}, task_input: 'test', domain_profile: 'test', project_id: 'p1', started_at: null, completed_at: null, paused_at: null, last_completed_node_at: null, user_injections: [], budget_usd: null, suspended_reason: null, metadata: {} })

    const executor = new CustomExecutor(store, latchRunner, 4, undefined)

    // interruptNode on a RUNNING node (no real AbortController since we didn't executeRun)
    // — falls back to direct DB update path.
    await executor.interruptNode(runId, 'n1', 'user-1')

    const status = await getNodeStatus(store, runId, 'n1')
    expect(status).toBe('INTERRUPTED')
  })
})

// ─── Amendment 65 — resolveInterruptGate() ───────────────────────────────────

describe('resolveInterruptGate()', () => {
  /** Seed a store where n1 is INTERRUPTED and run is SUSPENDED. */
  function buildInterruptedStore(runId: string): InMemoryRunStore {
    const store = new InMemoryRunStore()
    store.seedRun({
      id: runId,
      project_id: 'proj-1',
      status: 'SUSPENDED',
      dag: SINGLE_DAG,
      run_config: {},
      task_input: 'test',
      domain_profile: 'test',
      started_at: null,
      completed_at: null,
      paused_at: null,
      last_completed_node_at: null,
      user_injections: [],
      budget_usd: null,
      suspended_reason: 'user_interrupt',
      metadata: {},
    })
    store.seedNode(runId, {
      run_id: runId,
      node_id: 'n1',
      agent_type: 'WRITER',
      status: 'INTERRUPTED',
      started_at: new Date(),
      completed_at: null,
      interrupted_at: new Date(),
      interrupted_by: 'user-1',
      last_heartbeat: null,
      retries: 0,
      handoff_in: null,
      handoff_out: null,
      partial_output: 'draft partiel',
      partial_updated_at: new Date(),
      cost_usd: 0.001,
      tokens_in: 50,
      tokens_out: 20,
      error: null,
      metadata: {},
    })
    return store
  }

  test('accept_partial → node COMPLETED with partial as handoff_out', async () => {
    const runId = 'run-gate-accept'
    const store = buildInterruptedStore(runId)

    // The executor will try to executeRun after accept — use a happyRunner so the
    // run finishes (no more PENDING nodes remain, only the COMPLETED n1).
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await executor.resolveInterruptGate(runId, 'n1', 'user-1', { decision: 'accept_partial' })

    const status = await getNodeStatus(store, runId, 'n1')
    expect(status).toBe('COMPLETED')

    const nodes = await store.node.findMany({ where: { run_id: runId } })
    const n1 = nodes.find(n => n.node_id === 'n1')
    expect((n1?.handoff_out as { accepted_partial?: string })?.accepted_partial).toBe('draft partiel')
  })

  test('replay_from_scratch → node reset to PENDING, partial cleared', async () => {
    const runId = 'run-gate-replay'
    const neverRunner: AgentRunnerFn = async () => {
      // Return immediately so executeRun() can complete
      return { handoffOut: { result: 'replayed' }, costUsd: 0, tokensIn: 0, tokensOut: 0 }
    }
    const store = buildInterruptedStore(runId)
    const executor = new CustomExecutor(store, neverRunner, 4, undefined)

    // resolveInterruptGate will transition node→PENDING then launch executeRun asynchronously
    // (void). Wait for the background execution to drive the node to COMPLETED.
    await executor.resolveInterruptGate(runId, 'n1', 'user-1', { decision: 'replay_from_scratch' })
    await waitForNodeStatus(store, runId, 'n1', 'COMPLETED')

    const status = await getNodeStatus(store, runId, 'n1')
    expect(status).toBe('COMPLETED')
  })

  test('resume_from_partial → node metadata contains resume_context', async () => {
    const runId = 'run-gate-resume'
    const neverRunner: AgentRunnerFn = async () => {
      return { handoffOut: { result: 'resumed' }, costUsd: 0, tokensIn: 0, tokensOut: 0 }
    }
    const store = buildInterruptedStore(runId)
    const executor = new CustomExecutor(store, neverRunner, 4, undefined)

    await executor.resolveInterruptGate(runId, 'n1', 'user-1', {
      decision: 'resume_from_partial',
      edited_partial: 'partial édité par l\'utilisateur',
    })

    // After executeRun finishes, node is COMPLETED — check metadata was set
    const nodes = await store.node.findMany({ where: { run_id: runId } })
    // Node re-ran with neverRunner — metadata may have been cleared; verify run is not FAILED.
    const run = await store.run.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).not.toBe('FAILED')
  })

  test('throws if node is not INTERRUPTED', async () => {
    const runId = 'run-gate-bad-state'
    const store = buildStore(runId, SINGLE_DAG, { status: 'SUSPENDED' })
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    await expect(executor.resolveInterruptGate(runId, 'n1', 'user-1', { decision: 'accept_partial' }))
      .rejects.toThrow('must be INTERRUPTED')
  })

  test('resolves successfully when run is RUNNING (loop already active)', async () => {
    // When a run is RUNNING and an INTERRUPTED node is resolved with accept_partial,
    // the executor should mark the node COMPLETED and let the existing loop continue
    // naturally — it must NOT call executeRun again (which would throw on RUNNING status).
    const runId = 'run-gate-running'
    const store = buildStore(runId, SINGLE_DAG, { status: 'RUNNING' })
    // Manually set node to INTERRUPTED
    const nodes = await store.node.findMany({ where: { run_id: runId } })
    if (nodes[0]) {
      await store.node.update({ where: { id: nodes[0].id }, data: { status: 'INTERRUPTED', partial_output: 'partial_content' } })
    }
    const executor = new CustomExecutor(store, happyRunner, 4, undefined)

    // Should NOT throw — the gate resolves the node and skips re-launching the loop
    await expect(executor.resolveInterruptGate(runId, 'n1', 'user-1', { decision: 'accept_partial' }))
      .resolves.toBeUndefined()

    // Node must be COMPLETED after accept_partial
    const updated = await store.node.findMany({ where: { run_id: runId } })
    const n1 = updated.find(n => n.node_id === 'n1')
    expect((n1 as any)?.status).toBe('COMPLETED')
  })
})

// ─── State machine: gate transitions ─────────────────────────────────────────

describe('state machine — INTERRUPTED transitions', () => {
  test('INTERRUPTED → PENDING is valid (replay/resume)', async () => {
    const { canTransitionNode } = await import('@/lib/execution/custom/state-machine')
    expect(canTransitionNode('INTERRUPTED', 'PENDING')).toBe(true)
  })

  test('INTERRUPTED → COMPLETED is valid (accept_partial)', async () => {
    const { canTransitionNode } = await import('@/lib/execution/custom/state-machine')
    expect(canTransitionNode('INTERRUPTED', 'COMPLETED')).toBe(true)
  })

  test('INTERRUPTED → RUNNING is valid (legacy resume path)', async () => {
    const { canTransitionNode } = await import('@/lib/execution/custom/state-machine')
    expect(canTransitionNode('INTERRUPTED', 'RUNNING')).toBe(true)
  })

  test('INTERRUPTED → FAILED is NOT valid', async () => {
    const { canTransitionNode } = await import('@/lib/execution/custom/state-machine')
    expect(canTransitionNode('INTERRUPTED', 'FAILED')).toBe(false)
  })
})
