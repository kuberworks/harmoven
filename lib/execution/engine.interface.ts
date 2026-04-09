// lib/execution/engine.interface.ts
// IExecutionEngine — stable contract for all execution engine implementations.
// Amendment 82.5: the factory always returns IExecutionEngine — never call
// CustomExecutor, TemporalExecutor, or RestateExecutor directly.
// Amendments 63/64/65: pause, context injection, interrupt gate.

// ─── Domain types ─────────────────────────────────────────────────────────────

/**
 * A user-authored context injection (Amendment 64).
 * Stored as a JSON array on Run.user_injections.
 */
export interface UserInjection {
  id: string          // uuid
  created_at: string  // ISO-8601
  created_by: string  // actor id
  content: string     // max 2000 chars
  applies_to: 'all_pending'
}

/**
 * Interrupt Gate decision (Amendment 65).
 * Sent as the body of POST /api/runs/:id/nodes/:nodeId/gate.
 */
export type GateDecision =
  | { decision: 'resume_from_partial'; edited_partial: string; patch?: string }
  | { decision: 'replay_from_scratch'; patch?: string }
  | { decision: 'accept_partial' }

/** Output produced by an agent after executing a node. */
export interface AgentOutput {
  /** Handoff payload passed to the next node(s). Immutable once written. */
  handoffOut: unknown
  /** Cost in USD for this node execution. */
  costUsd: number
  /** Input tokens consumed. */
  tokensIn: number
  /** Output tokens produced. */
  tokensOut: number
  /**
   * The actual model string returned by the LLM provider for this node
   * (e.g. "claude-opus-4-5-20251001", "gpt-4o-2024-11-20").
   * Populated by runner.ts via ContextualLLMClient.lastModel.
   * Written to Node.llm_profile_id so the UI can display it.
   */
  llm_model?: string
}

/**
 * Minimal database interface the executor needs.
 * Satisfied by PrismaClient in production; by InMemoryRunStore in tests.
 */

/** Minimal shape for creating a new run (used by spawn follow-up). */
export interface SpawnRunData {
  id: string
  project_id: string
  created_by: string
  status: string
  domain_profile: string
  task_input: unknown
  dag: unknown
  run_config: unknown
  transparency_mode: boolean
  confidentiality: string
  budget_usd: unknown
  budget_tokens: unknown
  user_injections: unknown[]
  metadata: unknown
  task_input_chars: number
  data_expires_at: Date
}

/** Minimal shape for creating a node row (used by spawn follow-up). */
export interface SpawnNodeData {
  id: string
  run_id: string
  node_id: string
  agent_type: string
  status: string
  started_at: null
  completed_at: null
  interrupted_at: null
  interrupted_by: null
  last_heartbeat: null
  retries: number
  handoff_in: null
  handoff_out: null
  partial_output: null
  partial_updated_at: null
  cost_usd: number
  tokens_in: number
  tokens_out: number
  error: null
  metadata: unknown
}

export interface ExecutorDb {
  run: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<RunRow>
    update(args: { where: { id: string }; data: Partial<RunRow> }): Promise<RunRow>
    /** Create a new run row. Used when spawning follow-up runs from a REVIEWER verdict. */
    create(args: { data: SpawnRunData }): Promise<{ id: string }>
  }
  node: {
    findMany(args: { where: { run_id: string } }): Promise<NodeRow[]>
    /** Return all nodes with status RUNNING and last_heartbeat before the given date. */
    findOrphaned(args: { before: Date }): Promise<NodeRow[]>
    create(args: { data: Omit<NodeRow, 'id'> }): Promise<NodeRow>
    update(args: { where: { id: string }; data: Partial<NodeRow> }): Promise<NodeRow>
    updateMany(args: { where: { id?: string | { in: string[] }; run_id?: string; node_id?: string | { in: string[] }; status?: string | { in: string[] } }; data: Partial<NodeRow> }): Promise<{ count: number }>
    createMany(args: { data: Array<SpawnNodeData> }): Promise<{ count: number }>
    /** Delete node rows matching a run + node_id list. Used when a PLANNER is replayed. */
    deleteMany(args: { where: { run_id: string; node_id: { in: string[] } } }): Promise<{ count: number }>
  }
  handoff: {
    create(args: { data: unknown }): Promise<unknown>
    aggregate(args: { where: { run_id: string }; _max: { sequence_number: true } }): Promise<{ _max: { sequence_number: number | null } }>
    /** Insert a handoff row. sequence_number is assigned atomically by the DB SEQUENCE
     *  (@default(autoincrement())); callers must NOT supply it. */
    createAtomic(data: {
      run_id: string
      source_agent: string
      source_node_id: string | null | undefined
      target_agent: string
      payload: unknown
    }): Promise<void>
  }
  humanGate: {
    create(args: { data: unknown }): Promise<{ id: string }>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
  }
  auditLog: {
    create(args: { data: unknown }): Promise<unknown>
  }
  runDependency: {
    /** Create a parent → child run dependency row. */
    create(args: { data: { child_run_id: string; parent_run_id: string } }): Promise<unknown>
    /** Find all parent run dependency rows for a given child run. */
    findMany(args: { where: { child_run_id: string } }): Promise<Array<{
      parent_run: { id: string; status: string }
    }>>
  }
}

/** Minimal run row shape used by the executor (subset of Prisma Run model). */
export interface RunRow {
  id: string
  project_id: string
  created_by: string
  status: string
  dag: unknown     // Dag JSON
  run_config: unknown
  task_input: unknown
  domain_profile: string
  transparency_mode: boolean
  confidentiality: string
  started_at: Date | null
  completed_at: Date | null
  paused_at: Date | null
  last_completed_node_at: Date | null  // Am.64 — context injection filtering
  user_injections: unknown             // Am.64 — UserInjection[] serialised as JSON
  budget_usd: unknown                  // Decimal | null
  suspended_reason: string | null
  metadata: unknown
  cost_actual_usd?: number | null
  tokens_actual?: number | null
}

/** Minimal node row shape used by the executor (subset of Prisma Node model). */
export interface NodeRow {
  id: string
  run_id: string
  node_id: string  // "n1", "n2" etc
  agent_type: string
  status: string
  started_at: Date | null
  completed_at: Date | null
  interrupted_at: Date | null
  interrupted_by: string | null
  last_heartbeat: Date | null
  retries: number
  handoff_in: unknown
  handoff_out: unknown
  partial_output: string | null
  partial_updated_at: Date | null
  cost_usd: number
  tokens_in: number
  tokens_out: number
  error: string | null
  metadata: unknown
}

/**
 * Agent runner function — executes a single agent node.
 * In production: calls IAgentRunner which builds context, calls ILLMClient.
 * In tests: replaced by MockAgentRunner which resolves immediately.
 *
 * @param onChunk          Optional streaming callback. Called for every text chunk
 *                         produced by the LLM. The executor accumulates chunks and
 *                         flushes to Node.partial_output every 5 s (spec §DoD partial_output).
 * @param onModelResolved  Optional callback fired once the first LLM call resolves
 *                         and the model string is known. The executor uses this to
 *                         emit a node_snapshot SSE event so the UI can display the
 *                         model while the node is still RUNNING (not only on completion).
 */
export type AgentRunnerFn = (
  node:             NodeRow,
  handoffIn:        unknown,
  signal:           AbortSignal,
  onChunk?:         (chunk: string) => void,
  onModelResolved?: (model: string) => void,
) => Promise<AgentOutput>

/**
 * IExecutionEngine — stable contract for DAG execution.
 * All engine implementations (custom, temporal, restate) implement this interface.
 * Amendment 82.5.
 */
export interface IExecutionEngine {
  /**
   * Execute a run. The run must exist in the DB with status PENDING or SUSPENDED.
   * Transitions: PENDING → RUNNING → COMPLETED | FAILED | SUSPENDED
   */
  executeRun(runId: string): Promise<void>

  /**
   * Cancel a run immediately. Aborts all in-flight nodes via AbortSignal.
   * Transitions run: RUNNING → FAILED with metadata.cancel_reason = 'user_cancelled'.
   */
  cancelRun(runId: string, actorId: string): Promise<void>

  /**
   * Pause a run. In-flight nodes complete, but no new nodes are started.
   * Transitions run: RUNNING → PAUSED (Amendment 63).
   */
  pauseRun(runId: string, actorId: string): Promise<void>

  /**
   * Resume a paused or suspended run.
   * Transitions run: PAUSED | SUSPENDED → RUNNING.
   */
  resumeRun(runId: string, actorId: string): Promise<void>

  // ─── Shutdown protocol (Am.34.3b) ─────────────────────────────────────────

  /** Whether the executor is in graceful shutdown mode. */
  isShuttingDown(): boolean

  /** Stop accepting new executeRun() calls (SIGTERM step 1). */
  stopAcceptingRuns(): void

  /** Whether any nodes are currently RUNNING. */
  hasRunningNodes(): boolean

  /** Mark all RUNNING nodes as FAILED with reason 'graceful_shutdown'. */
  markShutdownNodes(): Promise<void>

  /** Suspend all runs that had nodes interrupted by shutdown. */
  suspendInterruptedRuns(reason: string): Promise<void>

  /**
   * Startup recovery — scan the DB for orphaned RUNNING nodes (no heartbeat
   * within the threshold), mark them INTERRUPTED, and suspend their runs.
   * Call once after process start, before accepting new runs.
   *
   * @param orphanThresholdMs  Default: 3 × HEARTBEAT_INTERVAL_MS (90 s)
   * @returns number of nodes recovered
   */
  recoverOrphans(orphanThresholdMs?: number): Promise<{ recovered: number }>

  // ─── Amendment 64 — Context injection ─────────────────────────────────────

  /**
   * Append a user-authored context note to a run's injection list.
   * Content is validated (max 2000 chars). Injections are exposed to all
   * pending-node agent contexts that execute after this call.
   * The run may be RUNNING or PAUSED when this is called.
   */
  injectContext(runId: string, content: string, actorId: string): Promise<UserInjection>

  // ─── Amendment 65 — Streaming interruption + gate ─────────────────────────

  /**
   * Interrupt a single in-flight node using its per-node AbortController.
   * Sets node → INTERRUPTED, run → SUSPENDED, stores partial output.
   * Idempotent if the node is already INTERRUPTED.
   * Throws if the node is not currently RUNNING.
   */
  interruptNode(runId: string, nodeId: string, actorId: string): Promise<void>

  /**
   * Resolve an Interrupt Gate — called after a node has been INTERRUPTED, FAILED,
   * or to force-restart a COMPLETED node.
   * Three decisions are supported (see GateDecision):
   *   resume_from_partial — re-queue the node with the edited partial as seed context (INTERRUPTED only)
   *   replay_from_scratch — reset the node (and any downstream nodes if COMPLETED) to PENDING
   *   accept_partial      — mark the node COMPLETED using partial_output as handoff_out
   *
   * When the target node is COMPLETED and the run is RUNNING, a downstream cascade
   * is triggered: all transitively-dependent nodes are reset to PENDING and any
   * currently-RUNNING downstream nodes are aborted first.
   */
  resolveInterruptGate(
    runId: string,
    nodeId: string,
    actorId: string,
    gate: GateDecision,
  ): Promise<void>

  // ─── Re-review ─────────────────────────────────────────────────────────────

  /**
   * Replay a specific node on a COMPLETED run.
   * Resets the node (and any nodes downstream of it) to PENDING, transitions
   * the run back to SUSPENDED, and re-enters the execution loop.
   *
   * Intended use-case: "Re-run Reviewer" button at the end of a completed run.
   * `runs:replay` permission required at the API layer.
   */
  replayNode(runId: string, nodeId: string, actorId: string): Promise<void>
}
