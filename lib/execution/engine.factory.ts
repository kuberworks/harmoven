// lib/execution/engine.factory.ts
// createExecutionEngine() — factory that returns the correct IExecutionEngine
// based on DEPLOYMENT_MODE environment variable.
//
// Supported modes (T1.4):
//   docker   → CustomExecutor (default)
//   electron → CustomExecutor (Restate wired in v2)
//   test     → CustomExecutor with MockAgentRunner (CLI override)
//
// Temporal and Restate implementations are stubs until T3.x.

import type { AgentRunnerFn, ExecutorDb, IExecutionEngine } from '@/lib/execution/engine.interface'
import { CustomExecutor } from '@/lib/execution/custom/executor'

/** Configuration options for the execution engine factory. */
export interface EngineConfig {
  /**
   * Database client. Required in production.
   * Defaults to the global Prisma singleton in non-test environments.
   */
  db?: ExecutorDb
  /**
   * Agent runner function. Required in production after T1.6.
   * For T1.4 tests: pass a mock agent runner directly.
   */
  agentRunner?: AgentRunnerFn
}

/**
 * Create the execution engine for the current deployment mode.
 *
 * @example
 * // Production (docker-compose):
 * const engine = createExecutionEngine()
 *
 * @example
 * // Unit test:
 * const engine = createExecutionEngine({ db: store, agentRunner: mockRunner })
 */
export function createExecutionEngine(config: EngineConfig = {}): IExecutionEngine {
  const mode = process.env.DEPLOYMENT_MODE ?? 'docker'

  // Resolve db — lazy import to avoid loading Prisma in test environments
  // that pass their own db mock.
  const db = config.db ?? (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { db: prismaDb } = require('@/lib/db/client') as { db: ExecutorDb }
    return prismaDb
  })()

  // Agent runner placeholder — replaced by real IAgentRunner in T1.6
  const agentRunner: AgentRunnerFn = config.agentRunner ?? (async (_node, _handoffIn, _signal) => {
    throw new Error(
      'No agentRunner configured. Pass one via createExecutionEngine({ agentRunner }) or wire the real IAgentRunner (T1.6).',
    )
  })

  switch (mode) {
    case 'docker':
    case 'electron':
    case 'test':
    default:
      return new CustomExecutor(db, agentRunner)

    // T3.x stubs — will throw until implemented
    // case 'temporal': return new TemporalExecutor(db, agentRunner)
    // case 'restate':  return new RestateExecutor(db, agentRunner)
  }
}
