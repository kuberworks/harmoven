// lib/execution/custom/executor.ts
// CustomExecutor — default IExecutionEngine implementation.
// Spec: AGENTS-04-EXECUTION.md Section 34, Amendment 82.
//
// T1.4 scope: state machine, serial/parallel execution, cancel/pause/resume.
// T1.5 scope: MAX_CONCURRENT_NODES, heartbeat, orphan detection, crash recovery.
// T3.2 scope: context injection (Am.64), per-node interrupt + gate (Am.65).

import { randomUUID } from 'crypto'
import { uuidv7 } from '@/lib/utils/uuidv7'
import type { Dag } from '@/types/dag.types'
import type { NodeStatus, RunStatus } from '@/types/run.types'
import type {
  AgentRunnerFn,
  ExecutorDb,
  GateDecision,
  IExecutionEngine,
  NodeRow,
  UserInjection,
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
import type { IProjectEventBus, RunSSEEvent, ProjectLifecycleEvent } from '@/lib/events/project-event-bus.interface'
import { credentialVault } from '@/lib/execution/credential-scope'
import { PlannerExhaustionError } from '@/lib/agents/planner'
import type { PlannerHandoff }     from '@/lib/agents/planner'
import { gateTimeoutAt }          from '@/lib/execution/gate-timeout'
import { AgentCostError }         from '@/lib/agents/agent-cost-error'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Poll interval while waiting for in-flight nodes to settle. */
const POLL_INTERVAL_MS = 100

/**
 * Insert a Handoff row with an atomically computed sequence_number.
 * Delegates to db.handoff.createAtomic() which uses a PostgreSQL advisory lock
 * (in production) or an in-memory stub (in tests) to guarantee that two concurrent
 * node completions for the same run never produce duplicate sequence numbers.
 * This eliminates the P2002 unique-constraint error entirely.
 */
async function createHandoffAtomic(
  db: import('@/lib/execution/engine.interface').ExecutorDb,
  data: { run_id: string; source_agent: string; source_node_id: string | null | undefined; target_agent: string; payload: unknown },
): Promise<void> {
  await db.handoff.createAtomic(data)
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

  /** Per-node AbortControllers (Am.65) — keyed by node DB id (not node_id). */
  private _nodeAbortControllers = new Map<string, AbortController>()

  /** Per-node heartbeat timers — pulse last_heartbeat every HEARTBEAT_INTERVAL_MS. */
  private _heartbeat = new HeartbeatManager()

  /** Cache of runId → project_id, populated at executeRun() start, cleared on finish. */
  private _runProjectIds = new Map<string, string>()

  constructor(
    private db: ExecutorDb,
    private agentRunner: AgentRunnerFn,
    /** Max nodes that may run in parallel within a single run. Loaded from orchestrator.yaml. */
    private _maxConcurrentNodes = 4,
    /** Optional event bus — if omitted, event emission is a no-op. */
    private _eventBus?: IProjectEventBus,
  ) {}

  // ─── Event emission helper ────────────────────────────────────────────────

  /**
   * Emit an SSE event or project lifecycle event to the bus.
   * Fire-and-forget (void) — a bus failure must never block execution.
   */
  private _emit(
    runId: string,
    event: RunSSEEvent | ProjectLifecycleEvent,
  ): void {
    if (!this._eventBus) return
    const projectId = this._runProjectIds.get(runId)
    if (!projectId) return
    void this._eventBus.emit({
      project_id: projectId,
      run_id: runId,
      event,
      emitted_at: new Date(),
    }).catch((err: unknown) => {
      console.error(`[executor] event bus emit failed for run ${runId}:`, err)
    })
  }

  // ─── IExecutionEngine ─────────────────────────────────────────────────────

  async executeRun(runId: string): Promise<void> {
    if (!this._acceptingRuns) throw new Error('Executor is shutting down — not accepting new runs')

    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus

    // Allow starting from PENDING or resuming from SUSPENDED/PAUSED
    if (currentStatus !== 'PENDING' && currentStatus !== 'SUSPENDED' && currentStatus !== 'PAUSED') {
      throw new Error(`Cannot execute run in status '${currentStatus}' (must be PENDING, SUSPENDED, or PAUSED)`)
    }

    // Cache project_id for event emission throughout this run's lifecycle
    this._runProjectIds.set(runId, run.project_id)

    // Issue a scoped credential vault for this run (T3.9 — credentialVault wiring).
    // Providers are extracted from the run config if available; TTL = 60 min max.
    const runConfigRaw = run.run_config as Record<string, unknown> | null
    const providers = Array.isArray(runConfigRaw?.['providers'])
      ? (runConfigRaw['providers'] as string[])
      : []
    await credentialVault.issueRunScope(runId, run.project_id, providers, 60)

    await this.transitionRun(runId, currentStatus, 'RUNNING')
    if (!run.started_at) {
      await this.db.run.update({ where: { id: runId }, data: { started_at: new Date() } })
    }

    // Emit run_started lifecycle event for project stream
    const taskSummary = run.task_input == null
      ? ''
      : typeof run.task_input === 'string'
        ? (run.task_input as string).slice(0, 120)
        : JSON.stringify(run.task_input).slice(0, 120)
    this._emit(runId, {
      type: 'run_started',
      profile: (run.domain_profile as string | undefined | null) ?? 'unknown',
      task_summary: taskSummary,
    })

    const controller = new AbortController()
    this._cancelSignals.set(runId, controller)

    try {
      await this.executionLoop(runId, run.dag as Dag, controller.signal)
    } finally {
      this._cancelSignals.delete(runId)
      this._pausedRunIds.delete(runId)
      this._runProjectIds.delete(runId)
      // Revoke credential scope regardless of outcome (T3.9 — vault cleanup).
      credentialVault.revokeRunScope(runId)
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
      data: { id: uuidv7(), actor: actorId, action_type: 'run_cancelled', run_id: runId, payload: { reason: 'user_cancelled' } },
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
      data: { id: uuidv7(), actor: actorId, action_type: 'run_paused', run_id: runId, payload: {} },
    })
  }

  async resumeRun(runId: string, actorId: string): Promise<void> {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus
    assertRunTransition(currentStatus, 'RUNNING', runId)

    this._pausedRunIds.delete(runId)

    await this.db.auditLog.create({
      data: { id: uuidv7(), actor: actorId, action_type: 'run_resumed', run_id: runId, payload: {} },
    })

    // Special case: planner_exhausted → the PLANNER node is FAILED or INTERRUPTED
    // (INTERRUPTED if the server crashed mid-execution and orphan-detection fired).
    // No downstream nodes were created (DAG expansion never ran). Reset the PLANNER
    // node to PENDING so the execution loop can retry it after the operator unblocks.
    if (run.suspended_reason === 'planner_exhausted') {
      const nodes = await this.db.node.findMany({ where: { run_id: runId } })
      const stalledPlanner = nodes.find(
        n => n.agent_type === 'PLANNER' && (n.status === 'FAILED' || n.status === 'INTERRUPTED'),
      )
      if (stalledPlanner) {
        await this.db.node.update({
          where: { id: stalledPlanner.id },
          data: {
            status:         'PENDING',
            error:          null,
            started_at:     null,
            completed_at:   null,
            interrupted_at: null,
            interrupted_by: null,
            retries:        0,
          },
        })
        this._emit(runId, { type: 'state_change', entity_type: 'node', id: stalledPlanner.node_id, status: 'PENDING' })
      }
      await this.db.run.update({ where: { id: runId }, data: { suspended_reason: null } })
    }

    // The execution loop exited cleanly when it detected PAUSED/SUSPENDED status.
    // Fire executeRun in the background — same pattern as the initial run creation
    // (POST /api/runs uses `void engine.executeRun()`).
    // NOT awaited: resumeRun must return promptly so that the HTTP response is sent
    // before the whole run completes; otherwise the Resume button spinner hangs for
    // the entire run duration.
    void this.executeRun(runId)
  }

  // ─── Amendment 64 — Context injection ──────────────────────────────────────

  async injectContext(runId: string, content: string, actorId: string): Promise<UserInjection> {
    if (content.length > 2000) {
      throw new Error('Injection content exceeds maximum length of 2000 characters')
    }
    if (content.trim().length === 0) {
      throw new Error('Injection content must not be empty')
    }

    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus
    if (currentStatus !== 'RUNNING' && currentStatus !== 'PAUSED') {
      throw new Error(`Cannot inject context into a run with status '${currentStatus}' (must be RUNNING or PAUSED)`)
    }

    const injection: UserInjection = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      created_by: actorId,
      content: content.trim(),
      applies_to: 'all_pending',
    }

    const existing = Array.isArray(run.user_injections) ? run.user_injections as UserInjection[] : []
    await this.db.run.update({
      where: { id: runId },
      data: { user_injections: [...existing, injection] },
    })

    await this.db.auditLog.create({
      data: {
        id: uuidv7(),
        run_id: runId,
        actor: actorId,
        action_type: 'context_injected',
        payload: { injection_id: injection.id, length: injection.content.length },
      },
    })

    this._emit(runId, {
      type: 'state_change',
      entity_type: 'run',
      id: runId,
      status: currentStatus,
      // Extra metadata visible to frontend via SSE — signals new injection
      ...({ context_injected: true, injection_id: injection.id } as object),
    })

    return injection
  }

  // ─── Amendment 65 — Per-node interruption ──────────────────────────────────

  async interruptNode(runId: string, nodeId: string, actorId: string): Promise<void> {
    // nodeId here is the node_id field ("n1", "n2", …), not the DB primary key.
    const nodes = await this.db.node.findMany({ where: { run_id: runId } })
    const node = nodes.find(n => n.node_id === nodeId)
    if (!node) throw new Error(`Node '${nodeId}' not found in run '${runId}'`)
    if (node.status !== 'RUNNING') {
      throw new Error(`Cannot interrupt node '${nodeId}' with status '${node.status}' (must be RUNNING)`)
    }

    // Abort the per-node controller — executeNode()'s catch block will set the node INTERRUPTED.
    const nodeController = this._nodeAbortControllers.get(node.id)
    if (nodeController) {
      nodeController.abort()
    } else {
      // Controller not found (e.g. race condition, already cleaned up) — transition directly.
      await this.db.node.update({
        where: { id: node.id },
        data: { status: 'INTERRUPTED', interrupted_at: new Date(), interrupted_by: actorId },
      })
      this._emit(runId, { type: 'state_change', entity_type: 'node', id: nodeId, status: 'INTERRUPTED' })
    }

    // Suspend the run so no new nodes start while the gate is open.
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const currentStatus = run.status as RunStatus
    if (currentStatus === 'RUNNING') {
      await this.transitionRun(runId, 'RUNNING', 'SUSPENDED')
      await this.db.run.update({
        where: { id: runId },
        data: { suspended_reason: 'user_interrupt' },
      })
    }

    await this.db.auditLog.create({
      data: {
        id: uuidv7(),
        run_id: runId,
        node_id: nodeId,
        actor: actorId,
        action_type: 'node_interrupted',
        payload: { trigger: 'user' },
      },
    })
  }

  // ─── Amendment 65 — Interrupt Gate resolution ──────────────────────────────

  async resolveInterruptGate(
    runId: string,
    nodeId: string,
    actorId: string,
    gate: GateDecision,
  ): Promise<void> {
    const nodes = await this.db.node.findMany({ where: { run_id: runId } })
    const node = nodes.find(n => n.node_id === nodeId)
    if (!node) throw new Error(`Node '${nodeId}' not found in run '${runId}'`)
    const canRestart = node.status === 'INTERRUPTED' || node.status === 'FAILED'
    if (!canRestart) {
      throw new Error(`Node '${nodeId}' cannot be restarted (status: '${node.status}') — must be INTERRUPTED or FAILED`)
    }
    // resume_from_partial requires partial output, only valid for INTERRUPTED nodes
    if (gate.decision === 'resume_from_partial' && node.status !== 'INTERRUPTED') {
      throw new Error(`Node '${nodeId}' must be INTERRUPTED to resume from partial`)
    }

    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const runCanResume = run.status === 'SUSPENDED' || run.status === 'FAILED'
    if (!runCanResume) {
      throw new Error(`Run '${runId}' cannot be restarted (status: '${run.status}') — must be SUSPENDED or FAILED`)
    }

    // ── Atomic claim ──────────────────────────────────────────────────────────
    // Use a conditional updateMany to atomically transition the node from
    // INTERRUPTED/FAILED → PENDING. This prevents two concurrent gate calls for
    // the same node from both proceeding: only the first one will find count > 0.
    const claimed = await this.db.node.updateMany({
      where: { id: node.id, status: { in: ['INTERRUPTED', 'FAILED'] } },
      data:  { status: 'PENDING' },
    })
    if (claimed.count === 0) {
      throw new Error(`Node '${nodeId}' cannot be restarted (status: '${node.status}') — already claimed by a concurrent gate request`)
    }

    switch (gate.decision) {
      case 'resume_from_partial': {
        // Atomic claim already set status = 'PENDING'. Update remaining fields.
        const meta = (node.metadata as object) ?? {}
        await this.db.node.update({
          where: { id: node.id },
          data: {
            interrupted_at: null,
            interrupted_by: null,
            partial_output: null,
            partial_updated_at: null,
            error: null,
            metadata: { ...meta, resume_context: gate.edited_partial, patch: gate.patch ?? null },
          },
        })
        await this.db.auditLog.create({
          data: {
            id: uuidv7(),
            run_id: runId, node_id: nodeId, actor: actorId,
            action_type: 'gate_resume_from_partial',
            payload: { partial_length: gate.edited_partial.length },
          },
        })
        this._emit(runId, { type: 'state_change', entity_type: 'node', id: nodeId, status: 'PENDING' })
        // Resume execution — executeRun accepts SUSPENDED and will pick up the PENDING node.
        await this.executeRun(runId)
        break
      }

      case 'replay_from_scratch': {
        // Atomic claim already set status = 'PENDING'. Update remaining fields.
        await this.db.node.update({
          where: { id: node.id },
          data: {
            interrupted_at: null,
            interrupted_by: null,
            partial_output: null,
            partial_updated_at: null,
            error: null,
          },
        })
        // If the run itself is FAILED/SUSPENDED, reset it to PENDING so executeRun proceeds.
        if (run.status !== 'SUSPENDED') {
          await this.db.run.update({
            where: { id: runId },
            data: { status: 'PENDING', started_at: null },
          })
        }
        await this.db.auditLog.create({
          data: {
            id: uuidv7(),
            run_id: runId, node_id: nodeId, actor: actorId,
            action_type: 'gate_replay_from_scratch',
            payload: { patch: gate.patch ?? null, restarted_from: node.status },
          },
        })
        this._emit(runId, { type: 'state_change', entity_type: 'node', id: nodeId, status: 'PENDING' })
        await this.executeRun(runId)
        break
      }

      case 'accept_partial': {
        // Promote partial_output to the final handoff_out; mark node COMPLETED.
        const partialContent = node.partial_output ?? ''
        await createHandoffAtomic(this.db, {
          run_id:         runId,
          source_agent:   node.agent_type,
          source_node_id: nodeId,
          target_agent:   'next',
          payload:        { accepted_partial: partialContent },
        })
        await this.db.node.update({
          where: { id: node.id },
          data: {
            status: 'COMPLETED',
            handoff_out: { accepted_partial: partialContent },
            completed_at: new Date(),
            interrupted_at: null,
            interrupted_by: null,
            error: null,
          },
        })
        await this.db.auditLog.create({
          data: {
            id: uuidv7(),
            run_id: runId, node_id: nodeId, actor: actorId,
            action_type: 'gate_accept_partial',
            payload: { partial_length: partialContent.length },
          },
        })
        this._emit(runId, { type: 'state_change', entity_type: 'node', id: nodeId, status: 'COMPLETED' })
        // Re-enter the run — remaining PENDING nodes (if any) will be executed.
        await this.executeRun(runId)
        break
      }

      default: {
        const exhaustive: never = gate
        throw new Error(`Unknown gate decision: ${(exhaustive as GateDecision).decision}`)
      }
    }
  }

  // ─── Re-review a node from a COMPLETED run ─────────────────────────────────

  async replayNode(runId: string, nodeId: string, actorId: string): Promise<void> {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    if (run.status !== 'COMPLETED') {
      throw new Error(`Run '${runId}' must be COMPLETED to replay a node (current: '${run.status}')`)
    }

    const allNodes = await this.db.node.findMany({ where: { run_id: runId } })
    const target   = allNodes.find(n => n.node_id === nodeId)
    if (!target) throw new Error(`Node '${nodeId}' not found in run '${runId}'`)

    // Collect the target node plus any downstream nodes (nodes that directly or
    // transitively depend on it). We reset them all so the reviewer output is
    // not mixed with stale downstream data.
    const dag = run.dag as Dag
    const downstreamIds = new Set<string>()
    downstreamIds.add(nodeId)
    let changed = true
    while (changed) {
      changed = false
      for (const edge of dag.edges) {
        if (downstreamIds.has(edge.from) && !downstreamIds.has(edge.to)) {
          downstreamIds.add(edge.to)
          changed = true
        }
      }
    }

    // Reset all collected nodes to PENDING (bypasses state machine — this is an
    // explicit admin/user action, not an automated transition).
    await this.db.node.updateMany({
      where: { run_id: runId, node_id: { in: [...downstreamIds] } },
      data:  {
        status:             'PENDING',
        started_at:         null,
        completed_at:       null,
        interrupted_at:     null,
        interrupted_by:     null,
        partial_output:     null,
        partial_updated_at: null,
        error:              null,
        cost_usd:           0,
        tokens_in:          0,
        tokens_out:         0,
      },
    })

    // Transition run back to SUSPENDED so executeRun can pick it up.
    // Direct DB update — the state machine has COMPLETED as terminal, but this is
    // an explicit user-initiated re-review action, not an automated transition.
    await this.db.run.update({
      where: { id: runId },
      data:  { status: 'SUSPENDED', completed_at: null, suspended_reason: 're_review' },
    })

    await this.db.auditLog.create({
      data: {
        id:          uuidv7(),
        run_id:      runId,
        node_id:     nodeId,
        actor:       actorId,
        action_type: 'node_re_review',
        payload:     { reset_nodes: [...downstreamIds] },
      },
    })

    // Emit SSE updates for each reset node so the client reflects PENDING status
    for (const nid of downstreamIds) {
      this._emit(runId, { type: 'state_change', entity_type: 'node', id: nid, status: 'PENDING' })
    }
    this._emit(runId, { type: 'state_change', entity_type: 'run', id: runId, status: 'SUSPENDED' })

    // Re-enter the execution loop
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
    // Spec §34.3b: mark RUNNING nodes as FAILED with a recognisable error message.
    // Crash recovery on the next startup will find these FAILED nodes in SUSPENDED runs
    // and reset them to PENDING for re-execution (FAILED → RUNNING is a valid transition).
    this._heartbeat.stopAll()
    for (const nodeId of this._runningNodeIds) {
      const runId = this._nodeRunId.get(nodeId)
      if (runId) this._interruptedRunIds.add(runId)
      await this.db.node.update({
        where: { id: nodeId },
        data: {
          status: 'FAILED',
          error: 'Process shutdown before completion',
        },
      })
      if (runId) {
        await this.db.auditLog.create({
          data: {
            id: uuidv7(),
            run_id: runId,
            actor: 'system',
            action_type: 'node_shutdown',
            payload: { node_db_id: nodeId, reason: 'graceful_shutdown' },
          },
        })
      }
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
      } catch (err) {
        // Run may have been deleted or already in terminal state — skip.
        console.error(`[executor] suspendInterruptedRuns failed for run ${runId}:`, err)
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
          id: uuidv7(),
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
      } catch (err) {
        // Run not found or already terminal — skip.
        console.error(`[executor] recoverOrphans: failed to suspend run ${runId}:`, err)
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

      // Check if the run was paused or suspended for human gate — exit the loop cleanly.
      // resumeRun() / resolveInterruptGate() will call executeRun() again to restart.
      const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
      if (run.status === 'PAUSED' || run.status === 'SUSPENDED' || this._pausedRunIds.has(runId)) {
        return  // exit without finalizing — resume will re-enter
      }

      // Reload DAG from DB every iteration — it may have been expanded by the PLANNER.
      dag = run.dag as Dag

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
      // Use the in-memory _nodeRunId map (updated synchronously in executeNode before
      // any await) instead of stale DB status, so fire-and-forget launches are counted
      // immediately and we never start more than _maxConcurrentNodes nodes per run.
      const alreadyRunning = [...this._nodeRunId.values()].filter(r => r === runId).length
      const slots = Math.max(0, this._maxConcurrentNodes - alreadyRunning)
      if (slots === 0) {
        await sleep(POLL_INTERVAL_MS)
        continue
      }
      const batch = readyNodes.slice(0, slots)
      // Launch each ready node independently — do NOT await the whole batch.
      // Each executeNode manages its own lifecycle (state transitions, heartbeat,
      // audit log) and writes its final status back to the DB.
      // The outer loop re-evaluates `alreadyRunning` from the DB every
      // POLL_INTERVAL_MS, so a slot freed by a fast node is reused immediately
      // rather than waiting for the entire batch to finish (real slot pool).
      for (const node of batch) {
        void this.executeNode(runId, node, signal)
      }
      await sleep(POLL_INTERVAL_MS)
    }

    // Finalize run status.
    // Guard: if the run was suspended (e.g. planner exhausted → human gate), do NOT
    // override that back to FAILED — the executor exits and waits for operator input.
    const finalNodes = await this.db.node.findMany({ where: { run_id: runId } })
    if (!signal.aborted) {
      const finalStatus = this.computeFinalRunStatus(finalNodes)
      const currentRun = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
      const currentStatus = currentRun.status as RunStatus
      if (!isTerminalRun(currentStatus) && currentStatus !== 'SUSPENDED') {
        const completedAt = new Date()
        await this.transitionRun(runId, currentStatus, finalStatus)
        await this.db.run.update({ where: { id: runId }, data: { completed_at: completedAt } })

        // Emit terminal-state SSE events.
        // IMPORTANT: use the post-transition values for status and completed_at.
        // `currentRun` was fetched BEFORE transitionRun(), so its status field
        // still reflects the old value (e.g. RUNNING). The client reducer replaces
        // the entire run object when it receives `completed`, so emitting the stale
        // snapshot would overwrite the correct COMPLETED status that the preceding
        // `state_change` event already applied, causing the UI to show "running"
        // even after the run has finished.
        if (finalStatus === 'COMPLETED') {
          this._emit(runId, {
            type: 'completed',
            run: {
              ...currentRun,
              status: finalStatus,
              completed_at: completedAt,
            },
            handoff_note: '',
          })
        }
        // run_finished lifecycle event (always, regardless of terminal status)
        this._emit(runId, { type: 'run_finished', status: finalStatus })
      }
    }
  }

  private async executeNode(runId: string, node: NodeRow, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return

    // Abort early if shutting down (check BEFORE the expensive LLM call — Am.34.3b).
    // The node is still PENDING — leave it untouched so it is re-queued when the run
    // resumes after restart. Register the runId so suspendInterruptedRuns() picks it up.
    if (this._shuttingDown) {
      this._interruptedRunIds.add(runId)
      return
    }

    // Claim this node synchronously — BEFORE the first await — so the execution loop
    // never double-launches the same node across two iterations.  Without this guard,
    // a slow DB round-trip in the first executeNode() invocation could keep the node
    // in PENDING status long enough for the loop to fire a second one, producing two
    // concurrent agent calls and duplicate handoff inserts.
    // JS is single-threaded so this check+add is atomic w.r.t. the event loop.
    if (this._runningNodeIds.has(node.id)) return
    this._runningNodeIds.add(node.id)
    this._nodeRunId.set(node.id, runId)

    // Collect handoff inputs from upstream nodes
    const nodes = await this.db.node.findMany({ where: { run_id: runId } })
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const dag = run.dag as Dag
    const handoffIn = this.collectHandoffIn(node, nodes, dag)

    // Transition to RUNNING
    await this.transitionNode(node, 'RUNNING')
    const nodeStartedAt = new Date()
    await this.db.node.update({
      where: { id: node.id },
      data: { started_at: nodeStartedAt, last_heartbeat: nodeStartedAt },
    })
    this._emit(runId, { type: 'node_snapshot', node_id: node.node_id ?? node.id, data: { started_at: nodeStartedAt.toISOString() } })

    // Start heartbeat — keeps last_heartbeat fresh so orphan detection ignores this node.
    this._heartbeat.start(node.id, async () => {
      try {
        await this.db.node.update({
          where: { id: node.id },
          data: { last_heartbeat: new Date() },
        })
      } catch (err) {
        // Log but do not rethrow — a missed pulse is not fatal; orphan detection
        // has a 3x threshold (90 s) before marking a node stale.
        console.error(`[executor] heartbeat failed for node ${node.id}:`, err)
      }
    })

    // ─── Per-node AbortController (Am.65) ─────────────────────────────────
    // Create a node-level controller linked to the run-level signal, so that
    // cancelling the entire run aborts all nodes, while interruptNode() can
    // abort a single node without cancelling the whole run.
    const nodeController = new AbortController()
    this._nodeAbortControllers.set(node.id, nodeController)
    // Propagate run-level abort to the node signal.
    signal.addEventListener('abort', () => nodeController.abort(), { once: true })
    const nodeSignal = nodeController.signal

    // ─── partial_output 5s flush (spec §DoD) ───────────────────────────────
    // Declared before try so that clearInterval() in finally block can access it.
    let _partialBuffer = ''
    let _partialFlush: ReturnType<typeof setInterval> | undefined

    try {
      // ─── Initialise partial flush interval ────────────────────────────────
      // Accumulate streaming chunks in memory and flush to DB every 5 s.
      // This allows the Interrupt Gate (Am.65) accept_partial / resume_from_partial
      // decisions to work with real content instead of an empty string.
      _partialFlush = setInterval(() => {
        if (_partialBuffer.length === 0) return
        const snapshot = _partialBuffer
        void this.db.node.update({
          where: { id: node.id },
          data:  { partial_output: snapshot, partial_updated_at: new Date() },
        }).then(() => {
          this._emit(runId, { type: 'node_snapshot', node_id: node.node_id ?? node.id, data: { partial_output: snapshot } })
        }).catch((err: unknown) => {
          console.error(`[executor] partial_output flush failed for node ${node.id}:`, err)
        })
      }, 5_000)

      // ─── Per-chunk SSE emit (250ms throttle) ──────────────────────────────
      // DB flush stays at 5s for persistence, but SSE fires on every chunk so
      // the client sees tokens appear in near-real-time without waiting 5s.
      let _lastChunkEmit = 0
      const CHUNK_EMIT_THROTTLE_MS = 250

      const output = await this.agentRunner(node, handoffIn, nodeSignal, (chunk) => {
        _partialBuffer += chunk
        const now = Date.now()
        if (now - _lastChunkEmit >= CHUNK_EMIT_THROTTLE_MS) {
          _lastChunkEmit = now
          this._emit(runId, { type: 'node_snapshot', node_id: node.node_id ?? node.id, data: { partial_output: _partialBuffer } })
        }
      }, (model) => {
        // Emit the resolved model as soon as the first LLM call responds so the
        // run detail UI shows the model while the node is still RUNNING.
        this._emit(runId, { type: 'node_snapshot', node_id: node.node_id ?? node.id, data: { llm_profile_id: model } })
      })

      // Store handoff (immutable) — advisory lock guarantees no sequence_number collision
      await createHandoffAtomic(this.db, {
        run_id:         runId,
        source_agent:   node.agent_type,
        source_node_id: node.node_id ?? null,
        target_agent:   'next',
        payload:        output.handoffOut,
      })

      // Update node with output + cost + resolved LLM model.
      // Clear partial_output so pages loaded after run completion never show
      // the stale streaming buffer instead of the final handoff_out content.
      await this.db.node.update({
        where: { id: node.id },
        data: {
          handoff_out:         output.handoffOut,
          cost_usd:            output.costUsd,
          tokens_in:           output.tokensIn,
          tokens_out:          output.tokensOut,
          completed_at:        new Date(),
          partial_output:      null,
          partial_updated_at:  null,
          // Write the resolved model string (e.g. "claude-opus-4-5-20251001") so the
          // run detail UI can display which model executed this node.
          ...(output.llm_model ? {
            llm_profile_id:  output.llm_model,
            llm_assigned_at: new Date(),
          } : {}),
        },
      })

      // Am.64 — track the most recently completed node timestamp for context injection filtering.
      await this.db.run.update({
        where: { id: runId },
        data: { last_completed_node_at: new Date() },
      })

      // ── PLANNER DAG expansion ────────────────────────────────────────────────
      // When the PLANNER completes, its handoffOut contains a full plan (dag.nodes +
      // dag.edges for WRITER/REVIEWER/QA nodes). We merge those into the run DAG
      // and create the corresponding Node DB records so the execution loop can
      // pick up the new PENDING nodes immediately.
      if (node.agent_type === 'PLANNER' && output.handoffOut != null) {
        try {
          const plan = output.handoffOut as PlannerHandoff
          if (Array.isArray(plan.dag?.nodes) && plan.dag.nodes.length > 0) {
            const currentRun = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
            const currentDag = currentRun.dag as { nodes: { id: string; agent_type: string }[]; edges: { from: string; to: string }[] }

            // Build set of already-known node IDs to avoid duplicates.
            const existingIds = new Set(currentDag.nodes.map(n => n.id))

            // Compute next numeric suffix to avoid ID collisions with existing nodes.
            // Existing IDs like "n1", "n2" give max index 2; new nodes start at n3, n4…
            const maxExistingIndex = Math.max(
              0,
              ...currentDag.nodes
                .map(n => parseInt(n.id.replace(/^n/, ''), 10))
                .filter(i => !isNaN(i)),
            )

            // Build a remapping of PLANNER's node IDs → new unique IDs.
            // The LLM may reuse n1/n2/etc. that already exist — always remap all of them.
            const idRemap = new Map<string, string>()
            let nextIndex = maxExistingIndex + 1
            for (const pn of plan.dag.nodes) {
              idRemap.set(pn.node_id, `n${nextIndex++}`)
            }

            const newDagNodes = plan.dag.nodes.map(pn => ({
              id: idRemap.get(pn.node_id)!,
              agent_type: pn.agent,
            }))

            // Remap edge IDs; add edges from PLANNER to ALL root plan nodes (nodes with
            // no dependencies). The original code only added an edge to the first root,
            // leaving additional root nodes visually disconnected in the DAG.
            const remappedEdges = plan.dag.edges.map(e => ({
              from: idRemap.get(e.from) ?? e.from,
              to:   idRemap.get(e.to)   ?? e.to,
            }))
            const rootPlannerEdges = plan.dag.nodes
              .filter(pn => pn.dependencies.length === 0)
              .map(pn => ({ from: node.node_id, to: idRemap.get(pn.node_id)! }))
              .filter(e => e.to)
            const newDagEdges = [...rootPlannerEdges, ...remappedEdges]

            const expandedDag = {
              nodes: [...currentDag.nodes, ...newDagNodes],
              edges: [...currentDag.edges, ...newDagEdges],
            }

            // Persist expanded DAG.
            await this.db.run.update({ where: { id: runId }, data: { dag: expandedDag } })

            // Create Node DB records for each new plan node using their remapped IDs.
            for (const pn of plan.dag.nodes) {
              const remappedId = idRemap.get(pn.node_id)!
              // Remap deps to match new node IDs.
              const remappedDeps = pn.dependencies.map(dep => idRemap.get(dep) ?? dep)
              await this.db.node.create({
                data: {
                  run_id:         runId,
                  node_id:        remappedId,
                  agent_type:     pn.agent,
                  status:         'PENDING',
                  started_at:     null,
                  completed_at:   null,
                  interrupted_at: null,
                  interrupted_by: null,
                  last_heartbeat: null,
                  retries:        0,
                  handoff_in:     null,
                  handoff_out:    null,
                  partial_output: null,
                  partial_updated_at: null,
                  cost_usd:       0,
                  tokens_in:      0,
                  tokens_out:     0,
                  error:          null,
                  metadata: {
                    description:          pn.description,
                    complexity:           pn.complexity,
                    expected_output_type: pn.expected_output_type,
                    domain_profile:       plan.domain_profile,
                    dependencies:         remappedDeps,
                  },
                },
              })
            }

            // Emit full node list + expanded DAG so SSE subscribers see newly created nodes
            // and updated graph structure immediately.
            const allNodesAfterExpansion = await this.db.node.findMany({
              where: { run_id: runId },
            })
            this._emit(runId, {
              type: 'nodes_refresh',
              nodes: allNodesAfterExpansion.map(n => ({
                ...n,
                cost_usd: Number(n.cost_usd),
                started_at: n.started_at?.toISOString() ?? null,
                completed_at: n.completed_at?.toISOString() ?? null,
              })),
              dag: expandedDag,
            })
          }
        } catch (expandErr) {
          console.error(`[executor] Failed to expand DAG from PLANNER output for run ${runId}:`, expandErr)
          // Non-fatal — execution loop continues; if no new ready nodes, run will complete.
        }
      }


      // Accumulate cost to run (§34.3 updateCosts)
      if (output.costUsd > 0 || output.tokensIn > 0 || output.tokensOut > 0) {
        const currentRun = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
        const prevCost   = Number(currentRun.cost_actual_usd ?? 0)
        const prevTokens = currentRun.tokens_actual ?? 0
        const newCost    = prevCost + output.costUsd
        const newTokens = prevTokens + output.tokensIn + output.tokensOut
        await this.db.run.update({
          where: { id: runId },
          data: {
            cost_actual_usd: newCost,
            tokens_actual: newTokens,
          },
        })
        // Emit cost_update SSE event (filtered by stream:costs permission in SSE routes)
        const budget = (currentRun.budget_usd as number | null) ?? 0
        this._emit(runId, {
          type: 'cost_update',
          cost_usd: newCost,
          tokens: newTokens,
          percent_of_budget: budget > 0 ? Math.round((newCost / budget) * 100) : 0,
        })
      }

      // Transition to COMPLETED
      const freshNode = { ...node, status: 'RUNNING' }
      await this.transitionNode(freshNode as NodeRow, 'COMPLETED')
      // Emit full node snapshot so client gets cost/tokens/output without page refresh
      this._emit(runId, {
        type: 'node_snapshot',
        node_id: node.node_id ?? node.id,
        data: {
          status:         'COMPLETED',
          cost_usd:       output.costUsd,
          tokens_in:      output.tokensIn,
          tokens_out:     output.tokensOut,
          handoff_out:    output.handoffOut,
          completed_at:   new Date().toISOString(),
          partial_output: null,
          // Surface the resolved model string so the run detail UI can display it
          // without a page reload (NodeState.llm_profile_id in useRunStream).
          ...(output.llm_model ? { llm_profile_id: output.llm_model } : {}),
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      const isPlannerExhausted = err instanceof PlannerExhaustionError

      // If the agent incurred LLM cost before failing, capture it on the node and run.
      const partialCost = err instanceof AgentCostError ? err : null
      if (partialCost && (partialCost.costUsd > 0 || partialCost.tokensIn > 0)) {
        await this.db.node.update({
          where: { id: node.id },
          data: { cost_usd: partialCost.costUsd, tokens_in: partialCost.tokensIn, tokens_out: partialCost.tokensOut },
        }).catch(() => {})
        await this.db.run.findUniqueOrThrow({ where: { id: runId } }).then((currentRun) => {
          const newCost   = Number(currentRun.cost_actual_usd ?? 0) + partialCost.costUsd
          const newTokens = (currentRun.tokens_actual ?? 0) + partialCost.tokensIn + partialCost.tokensOut
          void this.db.run.update({
            where: { id: runId },
            data: { cost_actual_usd: newCost, tokens_actual: newTokens },
          }).catch(() => {})
          const budget = (currentRun.budget_usd as number | null) ?? 0
          this._emit(runId, {
            type: 'cost_update',
            cost_usd: newCost,
            tokens: newTokens,
            percent_of_budget: budget > 0 ? Math.round((newCost / budget) * 100) : 0,
          })
        }).catch(() => {})
      }

      if (isAbort) {
        await this.db.node.update({
          where: { id: node.id },
          data: { status: 'INTERRUPTED', interrupted_at: new Date(), interrupted_by: 'user' },
        })
        this._emit(runId, { type: 'node_snapshot', node_id: node.node_id ?? node.id, data: { status: 'INTERRUPTED' } })
      } else {
        await this.db.node.update({
          where: { id: node.id },
          data: { status: 'FAILED', error: message },
        })
        // Emit error SSE event and a full node snapshot so client updates status + error together
        this._emit(runId, { type: 'error', node_id: node.node_id ?? node.id, message })
        this._emit(runId, {
          type: 'node_snapshot',
          node_id: node.node_id ?? node.id,
          data: {
            status: 'FAILED',
            error: message,
            cost_usd: partialCost?.costUsd ?? 0,
            tokens_in: partialCost?.tokensIn ?? 0,
            tokens_out: partialCost?.tokensOut ?? 0,
          },
        })
      }

      if (isPlannerExhausted) {
        // Spec: "max 3 re-runs on validation failure → Human Gate if still invalid"
        // Open a HumanGate and suspend the run — do not fail it.
        try {
          const gate = await this.db.humanGate.create({
            data: {
              run_id:     runId,
              reason:     'planner_exhausted',
              timeout_at: gateTimeoutAt(),
              data: {
                node_id:  node.node_id,
                error:    message,
                attempts: (err as PlannerExhaustionError).attempts,
              },
            },
          })
          const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
          if (canTransitionRun(run.status as RunStatus, 'SUSPENDED')) {
            await this.transitionRun(runId, run.status as RunStatus, 'SUSPENDED')
            await this.db.run.update({
              where: { id: runId },
              data: { suspended_reason: 'planner_exhausted' },
            })
          }
          this._emit(runId, {
            type: 'human_gate',
            gate_id: gate.id,
            reason: 'planner_exhausted',
            data: { node_id: node.node_id, message },
          })
          this._emit(runId, { type: 'gate_opened', gate_id: gate.id, reason: 'planner_exhausted' })
        } catch (gateErr) {
          console.error(`[executor] Failed to open human gate for run ${runId}:`, gateErr)
        }
      }

      await this.db.auditLog.create({
        data: {
          id: uuidv7(),
          run_id: runId,
          node_id: node.node_id,
          actor: 'system',
          action_type: isAbort ? 'node_interrupted' : (isPlannerExhausted ? 'planner_gate_opened' : 'node_failed'),
          payload: { error: message },
        },
      })
    } finally {
      clearInterval(_partialFlush)
      this._heartbeat.stop(node.id)
      this._runningNodeIds.delete(node.id)
      this._nodeRunId.delete(node.id)
      this._nodeAbortControllers.delete(node.id)
    }
  }

  // ─── State transition helpers ─────────────────────────────────────────────

  private async transitionNode(node: NodeRow, to: NodeStatus): Promise<void> {
    assertNodeTransition(node.status as NodeStatus, to, node.id)
    await this.db.node.update({ where: { id: node.id }, data: { status: to } })
    await this.db.auditLog.create({
      data: {
        id: uuidv7(),
        run_id: node.run_id,
        node_id: node.node_id,
        actor: 'system',
        action_type: 'state_transition',
        payload: { entity: 'node', from: node.status, to },
      },
    })
    // Emit node state_change SSE event
    this._emit(node.run_id, {
      type: 'state_change',
      entity_type: 'node',
      id: node.node_id ?? node.id,
      status: to,
    })
  }

  private async transitionRun(runId: string, from: RunStatus, to: RunStatus): Promise<void> {
    assertRunTransition(from, to, runId)
    await this.db.run.update({ where: { id: runId }, data: { status: to } })
    await this.db.auditLog.create({
      data: {
        id: uuidv7(),
        run_id: runId,
        actor: 'system',
        action_type: 'state_transition',
        payload: { entity: 'run', from, to },
      },
    })
    // Emit run state_change SSE event
    this._emit(runId, {
      type: 'state_change',
      entity_type: 'run',
      id: runId,
      status: to,
    })
  }

  private async setRunFailed(runId: string, reason: string): Promise<void> {
    const run = await this.db.run.findUniqueOrThrow({ where: { id: runId } })
    const status = run.status as RunStatus
    if (!isTerminalRun(status) && canTransitionRun(status, 'FAILED')) {
      await this.transitionRun(runId, status, 'FAILED')
      await this.db.run.update({
        where: { id: runId },
        data: { metadata: { ...(run.metadata as object), failure_reason: reason } },
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
    // INTERRUPTED nodes (e.g. from AbortError) mean the run did not complete successfully.
    // BLOCKED nodes that were never unblocked also block a COMPLETED verdict.
    const hasFailure = nodes.some(
      n => n.status === 'FAILED' || n.status === 'DEADLOCKED' || n.status === 'INTERRUPTED' || n.status === 'BLOCKED',
    )
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
