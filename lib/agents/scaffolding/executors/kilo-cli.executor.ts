// lib/agents/scaffolding/executors/kilo-cli.executor.ts
// KiloCliExecutor — Kilo Code CLI execution backend (Am.72.4).
//
// STATUS: STUB — deferred to v1.1.
//
// Activation requires (Expert Mode only):
//   1. Project in Expert Mode
//   2. 'kilo-cli' skill admin-approved in the MCP Skills panel
//   3. kilocode CLI installed: npm install -g @kilocode/cli
//   4. execution_backend: kilo_cli in project config
//
// When v1.1 implementation ships:
//   - KiloCliExecutor.isAvailable() will check `kilocode --version` in PATH
//   - KiloCliExecutor.execute() will write a worktree-scoped permission config,
//     invoke `kilocode --auto --json`, and parse the JSON output
//   - Full spec: TECHNICAL.md Section 24.3, Amendment 72.4
//
// The factory (layer-agent-executor.factory.ts) loads this file via dynamic import
// (Am.95.2), so it is never bundled into the process unless kilo_cli is requested.

import type {
  ILayerAgentExecutor,
  LayerAgentInput,
  LayerAgentOutput,
} from '../layer-agent-executor.interface'

// ─── Error type ───────────────────────────────────────────────────────────────

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedError'
  }
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export class KiloCliExecutor implements ILayerAgentExecutor {
  readonly name = 'kilo_cli' as const

  /**
   * Returns false in v1 — the STUB is intentionally unavailable.
   * The factory falls back to LLMDirectExecutor when isAvailable() is false.
   */
  async isAvailable(): Promise<boolean> {
    return false
  }

  /**
   * Throws NotImplementedError — KiloCliExecutor is a STUB in v1.
   * The factory never calls execute() because isAvailable() returns false.
   * This guard exists in case someone instantiates the executor directly.
   */
  async execute(_input: LayerAgentInput): Promise<LayerAgentOutput> {
    throw new NotImplementedError(
      '[KiloCliExecutor] Kilo CLI execution backend is not implemented in v1. '
      + 'Planned for v1.1 once Am.72.5 eval criteria are met. '
      + 'Use LLMDirectExecutor (the default) or wait for the v1.1 release.',
    )
  }
}
