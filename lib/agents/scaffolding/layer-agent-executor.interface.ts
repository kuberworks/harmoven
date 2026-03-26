// lib/agents/scaffolding/layer-agent-executor.interface.ts
// ILayerAgentExecutor — contract for all layer-level code generation backends.
// Spec: TECHNICAL.md Section 24, Amendment 72.
//
// Two implementations in v1:
//   LLMDirectExecutor  → lib/…/executors/llm-direct.executor.ts (default, always available)
//   KiloCliExecutor    → lib/…/executors/kilo-cli.executor.ts   (STUB, deferred to v1.1)

// ─── Layer type ───────────────────────────────────────────────────────────────

/** Supported scaffolding layers — mirrors Planner output layer names. */
export type LayerType = 'db' | 'api' | 'ui' | 'infra' | 'test'

// ─── Input / Output ───────────────────────────────────────────────────────────

export interface LayerAgentInput {
  /** Full spec for this layer from the Planner handoff (markdown). */
  spec:          string
  /** Which architectural layer this agent is implementing. */
  layer:         LayerType
  /** Absolute path to the isolated git worktree for this run. */
  worktree_path: string
  /** Paths to context files loaded into LLM context (ARCHITECTURE.md etc.). */
  context_files: string[]
  /** Maximum spend allowed for this layer agent (USD). */
  budget_usd:    number
  /** DAG Run ID — for audit log and cost tracking. */
  run_id:        string
  /** DAG Node ID — for heartbeat updates. */
  node_id:       string
}

export interface LayerAgentOutput {
  success:        boolean
  /** Relative paths of files modified (empty for LLMDirectExecutor — all files are created). */
  files_modified: string[]
  /** Relative paths of files created in the worktree. */
  files_created:  string[]
  /** null = not run (LLMDirectExecutor); true/false = test suite outcome (KiloCliExecutor). */
  tests_passed:   boolean | null
  /** Best-effort cost in USD (0 for LLMDirectExecutor — tracked externally via token counts). */
  cost_usd:       number
  /** Wall-clock duration from execute() call to return. */
  duration_ms:    number
  /** Full raw output of the executor — forwarded to the Reviewer agent for context. */
  raw_output:     string
  /** Error message if success = false. */
  error?:         string
}

// ─── Executor interface ───────────────────────────────────────────────────────

/** ILayerAgentExecutor — one-line swap between LLM-direct and Kilo CLI backends. */
export interface ILayerAgentExecutor {
  /** Identifier surfaced in logs and the Human Gate Kilo Execution Log tab. */
  readonly name: 'llm_direct' | 'kilo_cli'
  /** True if this executor can actually run (always true for llm_direct; checks PATH for kilo_cli). */
  isAvailable(): Promise<boolean>
  /** Execute the layer agent and return a structured result. */
  execute(input: LayerAgentInput): Promise<LayerAgentOutput>
}
