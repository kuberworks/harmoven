// lib/execution/engine.interface.ts
// IExecutionEngine — stable contract for all execution engine implementations.
// Amendment 82.5: the factory always returns IExecutionEngine — never call
// CustomExecutor, TemporalExecutor, or RestateExecutor directly.

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
}

/**
 * Minimal database interface the executor needs.
 * Satisfied by PrismaClient in production; by InMemoryRunStore in tests.
 */
export interface ExecutorDb {
  run: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<RunRow>
    update(args: { where: { id: string }; data: Partial<RunRow> }): Promise<RunRow>
  }
  node: {
    findMany(args: { where: { run_id: string } }): Promise<NodeRow[]>
    /** Return all nodes with status RUNNING and last_heartbeat before the given date. */
    findOrphaned(args: { before: Date }): Promise<NodeRow[]>
    create(args: { data: Omit<NodeRow, 'id'> }): Promise<NodeRow>
    update(args: { where: { id: string }; data: Partial<NodeRow> }): Promise<NodeRow>
    updateMany(args: { where: { run_id: string; status?: string }; data: Partial<NodeRow> }): Promise<{ count: number }>
  }
  handoff: {
    create(args: { data: unknown }): Promise<unknown>
  }
  auditLog: {
    create(args: { data: unknown }): Promise<unknown>
  }
}

/** Minimal run row shape used by the executor (subset of Prisma Run model). */
export interface RunRow {
  id: string
  status: string
  dag: unknown     // Dag JSON
  run_config: unknown
  started_at: Date | null
  completed_at: Date | null
  paused_at: Date | null
  metadata: unknown
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
 */
export type AgentRunnerFn = (
  node: NodeRow,
  handoffIn: unknown,
  signal: AbortSignal,
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
}
