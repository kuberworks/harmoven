// lib/agents/scaffolding/layer-agent-executor.factory.ts
// Factory for ILayerAgentExecutor — Am.72.5 executor selection + Am.95.2 dynamic import.
//
// createLayerAgentExecutor() selects the backend based on project config:
//   - 'llm_direct' (default): always available, uses the injected ILLMClient
//   - 'kilo_cli' (Expert Mode opt-in): loads KiloCliExecutor via dynamic import;
//     if unavailable (isAvailable() = false), falls back to llm_direct silently
//
// Dynamic import (Am.95.2): KiloCliExecutor is NEVER loaded into the process
// unless execution_backend === 'kilo_cli' AND expert_mode === true.
// This prevents dead-weight imports for the 99 % of deployments that don't use Kilo.

import type { ILLMClient }          from '@/lib/llm/interface'
import type { ILayerAgentExecutor } from './layer-agent-executor.interface'

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ExecutorFactoryConfig {
  /**
   * Backend to use for layer agent execution.
   * 'llm_direct' is the default and always available.
   * 'kilo_cli' requires Expert Mode + skill approval (deferred to v1.1).
   */
  execution_backend?: 'llm_direct' | 'kilo_cli' | (string & {})
  /**
   * Whether the project is in Expert Mode.
   * Kilo CLI is only attempted when both execution_backend = 'kilo_cli'
   * AND expert_mode = true — preventing accidental activation.
   */
  expert_mode?: boolean
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an ILayerAgentExecutor for the given execution config.
 *
 * Selection logic (Am.72.5):
 *   1. If execution_backend = 'kilo_cli' AND expert_mode = true:
 *      a. Dynamically import KiloCliExecutor (Am.95.2)
 *      b. If isAvailable() → return it
 *      c. Otherwise → log warning, fall through to llm_direct
 *   2. Dynamically import LLMDirectExecutor, return new instance
 *
 * @param config  Project/run execution config
 * @param llm     ILLMClient passed to LLMDirectExecutor (unused by KiloCliExecutor)
 */
export async function createLayerAgentExecutor(
  config: ExecutorFactoryConfig,
  llm:    ILLMClient,
): Promise<ILayerAgentExecutor> {
  const wantsKilo =
    config.execution_backend === 'kilo_cli'
    && config.expert_mode === true

  if (wantsKilo) {
    // Am.95.2: dynamic import — KiloCliExecutor never imported unless requested
    const { KiloCliExecutor } = await import('./executors/kilo-cli.executor')
    const kilo = new KiloCliExecutor()

    if (await kilo.isAvailable()) {
      return kilo
    }

    // KiloCliExecutor unavailable (STUB in v1, or kilocode not in PATH in v1.1)
    // Fall back silently — no audit log in v1 (requires Prisma client at this layer)
    console.warn(
      '[LayerAgentExecutor] kilo_cli requested but not available — '
      + 'falling back to llm_direct. '
      + 'KiloCliExecutor is a STUB in v1; planned for v1.1.',
    )
  }

  // Am.95.2: dynamic import for symmetry — ensures consistent lazy-loading pattern
  const { LLMDirectExecutor } = await import('./executors/llm-direct.executor')
  return new LLMDirectExecutor(llm)
}
