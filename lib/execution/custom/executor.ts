// lib/execution/custom/executor.ts
// CustomExecutor — default IExecutionEngine implementation.
// Spec: AGENTS-04-EXECUTION.md Section 34, Amendment 82.
//
// T1.4 scope: state machine, serial/parallel execution, cancel/pause/resume.
// T1.5 scope: MAX_CONCURRENT_NODES, heartbeat, orphan detection, crash recovery.

import type { Dag } from '@/types/dag.types'
import type { NodeStatus, RunStatus } from '@/types/run.types'
import type {
  AgentRunnerFn,
  ExecutorDb,
  IExecutionEngine,
  NodeRow,
} from '@/lib/execution/engine.interface'
import {
  assertNodeTransition,
  assertRunTransition,
  canTransitionRun,
  isNodeDone,
  isTerminalNode,
  isTerminalRun,
} from '@/lib/execution/custom/state-machine'
import { HeartbeatManager, ORPHAN_THRESHOLD_MS } from '@/lib/execution/custom/heartbeat'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Poll interval while waiting for in-flight nodes to settle. */
const POLL_INTERVAL_MS = 100

// ─── InMemoryRunStore (for tests) ─────────────────────────────────────────────

/** Minimal in-memory DB that satisfies ExecutorDb — used in unit tests. */
export class InMemoryRunStore implements ExecutorDb {
  private _runs = new Map<string, Record<string, unknown>>()
  private _nodes = new Map<string, Array<Record<string, unknown>>>()
  private _auditLog: unknown[] = []
  private _handoffs: unknown[] = []

  seedRun(run: Record<string, unknown>): void {
    this._runs.set(run['id'] as string, { ...run })
    if (!this._nodes.has(run['id'] as string)) {
      this._nodes.set(run['id'] as string, [])
    }
  }

  seedNode(runId: string, node: Record<string, unknown>): void {
    const list = this._nodes.get(runId) ?? []
    // Auto-assign a unique id if not provided — prevents update() from matching wrong rows.
    const nodeWithId = node['id'] != null ? node : { ...node, id: crypto.randomUUID() }
    list.push(nodeWithId)
    this._nodes.set(runId, list)
  }

  getAuditLog(): unknown[] {
    return this._auditLog
  }

  // ─── ExecutorDb impl ───────────────────────────────────────────────────────

  run = {
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const r = this._runs.get(where.id)
      if (!r) throw new Error(`Run not found: ${where.id}`)
      return r as unknown as ReturnType<ExecutorDb['run']['findUniqueOrThrow']> extends Promise<infer T> ? T : never
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = this._runs.get(where.id)
      if (!r) throw new Error(`Run not found: ${where.id}`)
      Object.assign(r, data)
      return r as unknown as ReturnType<ExecutorDb['run']['update']> extends Promise<infer T> ? T : never
    },
  }

  node = {
    findMany: async ({ where }: { where: { run_id: string } }) => {
      return (this._nodes.get(where.run_id) ?? []) as unknown as ReturnType<ExecutorDb['node']['findMany']> extends Promise<infer T> ? T : never
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const node = { id: crypto.randomUUID(), ...data }
      const list = this._nodes.get(data['run_id'] as string) ?? []
      list.push(node)
      this._nodes.set(data['run_id'] as string, list)
      return node as unknown as ReturnType<ExecutorDb['node']['create']> extends Promise<infer T> ? T : never
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      let found: Record<string, unknown> | undefined
      for (const list of this._nodes.values()) {
        found = list.find(n => n['id'] === where.id) as Record<string, unknown> | undefined
        if (found) { Object.assign(found, data); break }
      }
      if (!found) throw new Error(`Node not found: ${where.id}`)
      return found as unknown as ReturnType<ExecutorDb['node']['update']> extends Promise<infer T> ? T : never
    },
    findOrphaned: async ({ before }: { before: Date }) => {
      const result: Record<string, unknown>[] = []
      for (const list of this._nodes.values()) {
        for (const node of list) {
          if (
            node['status'] === 'RUNNING' &&
            node['last_heartbeat'] != null &&
            (node['last_heartbeat'] as Date) < before
          ) {
            result.push(node)
          }
        }
      }
      return result as unknown as ReturnType<ExecutorDb['node']['findOrphaned']> extends Promise<infer T> ? T : never
    },
    updateMany: async ({ where, data }: { where: { run_id: string; status?: string }; data: Record<string, unknown> }) => {
      let count = 0
      const list = this._nodes.get(where.run_id) ?? []
      for (const node of list) {
        if (!where.status || node['status'] === where.status) {
          Object.assign(node, data)
          count++
        }
      }
      return { count } as unknown as ReturnType<ExecutorDb['node']['updateMany']> extends Promise<infer T> ? T : never
    },
  }

  handoff = {
    create: async ({ data }: { data: unknown }) => {
      this._handoffs.push(data)
      return data
    },
  }

  auditLog = {
    create: async ({ data }: { data: unknown }) => {
      this._auditLog.push(data)
      return data
    },
  }
}

// ─── CustomExecutor ───────────────────────────────────────────────────────────

export class CustomExecutor implements IExecutionEngine {
  private _shuttingDown = false
  private _acceptingRuns = true

  /** IDs of nodes currently being executed by this instance. */
  private _runningNodeIds = new Set<string>()

  /** Maps nodeId → runId to support suspendInterruptedRuns after markShutdownNodes. */
  private _nodeRunId = new Map<string, string>()

  /** Run IDs that had nodes interrupted during shutdown — consumed by suspendInterruptedRuns. */
  private _interruptedRunIds = new Set<string>()

  /** AbortControllers keyed by runId — used to cancel all in-flight nodes. */
  private _cancelSignals = new Map<string, AbortController>()

  /**
   * Runs currently in a paused state (executor-level flag, not DB).
   * The DB is also updated — this flag prevents new nodes from starting.
   */
  private _pausedRunIds = new Set<string>()

  /** Per-node heartbeat timers — pulse last_heartbeat every HEARTBEAT_INTERVAL_MS. */
  private _heartbeat = new HeartbeatManager()

  constructor(
    private db: ExecutorDb,
    private agentRunner: AgentRunnerFn,
    /** Max nodes that may run in parallel within a single run. Loaded from orchestrator.yaml. */
    private _maxConcurrentNodes = 4,
  ) {}

  // ─── IExecutionEngine ─────────────────────────────────────────────────────

  async executeRun(runId: string): Promise<void> {
    if (!this._acceptingRuns) throw new Error('Executor is shutting down — not accepting new runs')

    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus

    // Allow starting from PENDING or resuming from SUSPENDED/PAUSED
    if (currentStatus !== 'PENDING' && currentStatus !== 'SUSPENDED' && currentStatus !== 'PAUSED') {
      throw new Error(`Cannot execute run in status '${currentStatus}' (must be PENDING, SUSPENDED, or PAUSED)`)
    }

    await this.transitionRun(runId, currentStatus, 'RUNNING')
    if (!run.started_at) {
      await this.db.run.update({ where: { id: runId }, data: { started_at: new Date() } })
    }

    const controller = new AbortController()
    this._cancelSignals.set(runId, controller)

    try {
      await this.executionLoop(runId, run.dag as Dag, controller.signal)
    } finally {
      this._cancelSignals.delete(runId)
      this._pausedRunIds.delete(runId)
    }
  }

  async cancelRun(runId: string, actorId: string): Promise<void> {
    const controller = this._cancelSignals.get(runId)
    if (controller) controller.abort()

    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus
    if (!isTerminalRun(currentStatus)) {
      await this.transitionRun(runId, currentStatus, 'FAILED')
      await this.db.run.update({
        where: { id: runId },
        data: { metadata: { ...(run.metadata as object), cancel_reason: 'user_cancelled', cancelled_by: actorId } },
      })
    }

    await this.db.auditLog.create({
      data: { actor: actorId, action_type: 'run_cancelled', run_id: runId, payload: { reason: 'user_cancelled' } },
    })
  }

  async pauseRun(runId: string, actorId: string): Promise<void> {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus
    assertRunTransition(currentStatus, 'PAUSED', runId)

    this._pausedRunIds.add(runId)
    await this.transitionRun(runId, currentStatus, 'PAUSED')
    await this.db.run.update({ where: { id: runId }, data: { paused_at: new Date() } })

    await this.db.auditLog.create({
      data: { actor: actorId, action_type: 'run_paused', run_id: runId, payload: {} },
    })
  }

  async resumeRun(runId: string, actorId: string): Promise<void> {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus
    assertRunTransition(currentStatus, 'RUNNING', runId)

    this._pausedRunIds.delete(runId)

    await this.db.auditLog.create({
      data: { actor: actorId, action_type: 'run_resumed', run_id: runId, payload: {} },
    })

    // The execution loop exited cleanly when it detected PAUSED status.
    // Call executeRun again — it accepts PAUSED as a valid start status and resumes
    // from the last stable node state (COMPLETED nodes are skipped by getReadyNodes).
    await this.executeRun(runId)
  }

  isShuttingDown(): boolean {
    return this._shuttingDown
  }

  stopAcceptingRuns(): void {
    this._acceptingRuns = false
    this._shuttingDown = true
  }

  hasRunningNodes(): boolean {
    return this._runningNodeIds.size > 0
  }

  async markShutdownNodes(): Promise<void> {
    this._heartbeat.stopAll()
    for (const nodeId of this._runningNodeIds) {
      const runId = this._nodeRunId.get(nodeId)
      if (runId) this._interruptedRunIds.add(runId)
      await this.db.node.update({
        where: { id: nodeId },
        data: {
          status: 'INTERRUPTED',
          interrupted_at: new Date(),
          interrupted_by: 'graceful_shutdown',
          error: 'Process shutdown before completion',
        },
      })
    }
    this._runningNodeIds.clear()
    this._nodeRunId.clear()
  }

  async suspendInterruptedRuns(reason: string): Promise<void> {
    for (const runId of this._interruptedRunIds) {
      try {
        const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
        const status = run.status as RunStatus
        if (canTransitionRun(status, 'SUSPENDED')) {
          await this.transitionRun(runId, status, 'SUSPENDED')
          await this.db.run.update({
            where: { id: runId },
            data: { metadata: { ...(run.metadata as object), suspend_reason: reason } },
          })
        }
      } catch {
        // Run may have been deleted or already in terminal state — skip silently.
      }
    }
    this._interruptedRunIds.clear()
  }

  async recoverOrphans(orphanThresholdMs = ORPHAN_THRESHOLD_MS): Promise<{ recovered: number }> {
    const before = new Date(Date.now() - orphanThresholdMs)
    const orphaned = await this.db.node.findOrphaned({ before })

    const affectedRunIds = new Set<string>()
    for (const node of orphaned) {
      await this.db.node.update({
        where: { id: node.id },
        data: {
          status: 'INTERRUPTED',
          interrupted_at: new Date(),
          interrupted_by: 'orphan_detection',
          error: 'No heartbeat within orphan threshold — executor likely crashed',
        },
      })
      await this.db.auditLog.create({
        data: {
          run_id: node.run_id,
          node_id: node.node_id,
          actor: 'system',
          action_type: 'node_orphaned',
          payload: { threshold_ms: orphanThresholdMs },
        },
      })
      affectedRunIds.add(node.run_id)
    }

    for (const runId of affectedRunIds) {
      try {
        const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
        const status = run.status as RunStatus
        if (canTransitionRun(status, 'SUSPENDED')) {
          await this.transitionRun(runId, status, 'SUSPENDED')
          await this.db.run.update({
            where: { id: runId },
            data: { metadata: { ...(run.metadata as object), suspend_reason: 'orphan_recovery' } },
          })
        }
      } catch {
        // Run not found or already terminal — skip.
      }
    }

    return { recovered: orphaned.length }
  }

  // ─── Internal execution loop ──────────────────────────────────────────────

  private async executionLoop(
    runId: string,
    dag: Dag,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      // Check if the run was cancelled
      if (signal.aborted) {
        await this.setRunFailed(runId, 'Run cancelled')
        return
      }

      // Load current node states
      const nodes = await this.db.node.findMany({ where: { run_id: runId } })

      // Check terminal condition (all COMPLETED/SKIPPED/DEADLOCKED)
      if (this.allNodesTerminal(nodes)) break

      // Check if the run was paused — exit the loop cleanly.
      // resumeRun() will call executeRun() again from PAUSED status to restart.
      const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
      if (run.status === 'PAUSED' || this._pausedRunIds.has(runId)) {
        return  // exit without finalizing — resume will re-enter
      }

      // Find READY nodes: PENDING with all dependencies COMPLETED or SKIPPED
      const readyNodes = this.getReadyNodes(nodes, dag)

      if (readyNodes.length === 0) {
        // No ready nodes — check for in-flight nodes
        const running = nodes.some(n => n.status === 'RUNNING')
        if (!running) {
          // Nothing running, nothing ready — deadlock (deps failed/interrupted)
          // or all pending nodes are blocked indefinitely.
          break
        }
        await sleep(POLL_INTERVAL_MS)
        continue
      }

      // Execute ready nodes in parallel, capped at _maxConcurrentNodes per run.
      // Remaining ready nodes are picked up on the next loop iteration.
      const batch = readyNodes.slice(0, this._maxConcurrentNodes)
      await Promise.all(batch.map(node => this.executeNode(runId, node, signal)))
    }

    // Finalize run status
    const finalNodes = await this.db.node.findMany({ where: { run_id: runId } })
    if (!signal.aborted) {
      const finalStatus = this.computeFinalRunStatus(finalNodes)
      const currentRun = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
      const currentStatus = currentRun.status as RunStatus
      if (!isTerminalRun(currentStatus)) {
        await this.transitionRun(runId, currentStatus, finalStatus)
        await this.db.run.update({ where: { id: runId }, data: { completed_at: new Date() } })
      }
    }
  }

  private async executeNode(runId: string, node: NodeRow, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return

    // Abort early if shutting down (check BEFORE the expensive LLM call — Am.34.3b)
    if (this._shuttingDown) {
      await this.db.node.update({ where: { id: node.id }, data: { status: 'FAILED', error: 'Executor shutting down' } })
      return
    }

    // Collect handoff inputs from upstream nodes
    const nodes = await this.db.node.findMany({ where: { run_id: runId } })
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const dag = run.dag as Dag
    const handoffIn = this.collectHandoffIn(node, nodes, dag)

    // Transition to RUNNING
    await this.transitionNode(node, 'RUNNING')
    await this.db.node.update({
      where: { id: node.id },
      data: { started_at: new Date(), last_heartbeat: new Date() },
    })
    this._runningNodeIds.add(node.id)
    this._nodeRunId.set(node.id, runId)

    // Start heartbeat — keeps last_heartbeat fresh so orphan detection ignores this node.
    this._heartbeat.start(node.id, async () => {
      await this.db.node.update({
        where: { id: node.id },
        data: { last_heartbeat: new Date() },
      })
    })

    try {
      const output = await this.agentRunner(node, handoffIn, signal)

      // Store handoff (immutable)
      const allNodes = await this.db.node.findMany({ where: { run_id: runId } })
      const sequenceNumber = allNodes.filter(n => n.handoff_out != null).length + 1
      await this.db.handoff.create({
        data: {
          run_id: runId,
          sequence_number: sequenceNumber,
          source_agent: node.agent_type,
          source_node_id: node.node_id,
          target_agent: 'next',
          payload: output.handoffOut,
        },
      })

      // Update node with output + cost
      await this.db.node.update({
        where: { id: node.id },
        data: {
          handoff_out: output.handoffOut,
          cost_usd: output.costUsd,
          tokens_in: output.tokensIn,
          tokens_out: output.tokensOut,
          completed_at: new Date(),
        },
      })

      // Transition to COMPLETED
      const freshNode = { ...node, status: 'RUNNING' }
      await this.transitionNode(freshNode as NodeRow, 'COMPLETED')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isAbort = err instanceof DOMException && err.name === 'AbortError'

      if (isAbort) {
        await this.db.node.update({
          where: { id: node.id },
          data: { status: 'INTERRUPTED', interrupted_at: new Date(), interrupted_by: 'user' },
        })
      } else {
        await this.db.node.update({
          where: { id: node.id },
          data: { status: 'FAILED', error: message },
        })
      }

      await this.db.auditLog.create({
        data: {
          run_id: runId,
          node_id: node.node_id,
          actor: 'system',
          action_type: isAbort ? 'node_interrupted' : 'node_failed',
          payload: { error: message },
        },
      })
    } finally {
      this._heartbeat.stop(node.id)
      this._runningNodeIds.delete(node.id)
      this._nodeRunId.delete(node.id)
    }
  }

  // ─── State transition helpers ─────────────────────────────────────────────

  private async transitionNode(node: NodeRow, to: NodeStatus): Promise<void> {
    assertNodeTransition(node.status as NodeStatus, to, node.id)
    await this.db.node.update({ where: { id: node.id }, data: { status: to } })
    await this.db.auditLog.create({
      data: {
        run_id: node.run_id,
        node_id: node.node_id,
        actor: 'system',
        action_type: 'state_transition',
        payload: { entity: 'node', from: node.status, to },
      },
    })
  }

  private async transitionRun(runId: string, from: RunStatus, to: RunStatus): Promise<void> {
    assertRunTransition(from, to, runId)
    await this.db.run.update({ where: { id: runId }, data: { status: to } })
    await this.db.auditLog.create({
      data: {
        run_id: runId,
        actor: 'system',
        action_type: 'state_transition',
        payload: { entity: 'run', from, to },
      },
    })
  }

  private async setRunFailed(runId: string, reason: string): Promise<void> {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const status = run.status as RunStatus
    if (!isTerminalRun(status)) {
      await this.db.run.update({
        where: { id: runId },
        data: { status: 'FAILED', metadata: { ...(run.metadata as object), failure_reason: reason } },
      })
    }
  }

  // ─── DAG helpers ──────────────────────────────────────────────────────────

  /** Returns nodes that are PENDING and whose all dependencies are done. */
  private getReadyNodes(nodes: NodeRow[], dag: Dag): NodeRow[] {
    return nodes.filter(node => {
      if (node.status !== 'PENDING') return false

      // Find all dependencies of this node (edges pointing TO it)
      const depIds = dag.edges
        .filter(e => e.to === node.node_id)
        .map(e => e.from)

      if (depIds.length === 0) return true // No deps — ready immediately

      return depIds.every(depId => {
        const dep = nodes.find(n => n.node_id === depId)
        return dep != null && isNodeDone(dep.status as NodeStatus)
      })
    })
  }

  /** Returns true if all nodes are in a terminal or "stuck" state. */
  private allNodesTerminal(nodes: NodeRow[]): boolean {
    return nodes.every(n => isTerminalNode(n.status as NodeStatus))
  }

  /** Compute final run status based on node states. */
  private computeFinalRunStatus(nodes: NodeRow[]): RunStatus {
    const hasFailure = nodes.some(n => n.status === 'FAILED' || n.status === 'DEADLOCKED')
    return hasFailure ? 'FAILED' : 'COMPLETED'
  }

  /** Collect the handoff output from upstream completed nodes, merged into one payload. */
  private collectHandoffIn(
    node: NodeRow,
    allNodes: NodeRow[],
    dag: Dag,
  ): unknown {
    const depIds = dag.edges
      .filter(e => e.to === node.node_id)
      .map(e => e.from)

    if (depIds.length === 0) return null

    const outputs = depIds
      .map(depId => allNodes.find(n => n.node_id === depId)?.handoff_out)
      .filter(Boolean)

    return outputs.length === 1 ? outputs[0] : outputs
  }
}
