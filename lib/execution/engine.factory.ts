// lib/execution/engine.factory.ts
// createExecutionEngine() — factory that returns the correct IExecutionEngine
// based on DEPLOYMENT_MODE environment variable.
//
// Supported modes (T1.5):
//   docker   → CustomExecutor (default)
//   electron → CustomExecutor (Restate wired in v2)
//   test     → CustomExecutor with MockAgentRunner (CLI override)
//
// On startup: reads max_concurrent_nodes from orchestrator.yaml, registers
// SIGTERM shutdown protocol, and runs orphan recovery (Am.34.3a).
//
// Temporal and Restate implementations are stubs until T3.x.

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { AgentRunnerFn, ExecutorDb, IExecutionEngine } from '@/lib/execution/engine.interface'
import { CustomExecutor } from '@/lib/execution/custom/executor'

// ─── Orchestrator config loader ───────────────────────────────────────────────

interface OrchestratorYaml {
  execution_engine?: {
    max_concurrent_nodes?: number
  }
}

/** Read max_concurrent_nodes from orchestrator.yaml at the repo root. Defaults to 4. */
function loadMaxConcurrentNodes(): number {
  try {
    const yamlPath = path.resolve(process.cwd(), 'orchestrator.yaml')
    const raw = fs.readFileSync(yamlPath, 'utf8')
    const config = yaml.load(raw) as OrchestratorYaml
    return config?.execution_engine?.max_concurrent_nodes ?? 4
  } catch {
    return 4
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

/** Max time (ms) to wait for in-flight nodes to finish before forcibly marking them down. */
const SHUTDOWN_TIMEOUT_MS = 30_000
const SHUTDOWN_POLL_MS     = 200

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Register a once-only SIGTERM handler that implements the Am.34.3b shutdown protocol:
 * 1. Stop accepting new runs
 * 2. Wait up to 30 s for in-flight nodes to complete
 * 3. Mark remaining RUNNING nodes as INTERRUPTED
 * 4. Suspend affected runs
 * 5. Exit 0
 */
function registerSigtermHandler(engine: IExecutionEngine): void {
  process.once('SIGTERM', () => {
    void (async () => {
      engine.stopAcceptingRuns()

      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
      while (engine.hasRunningNodes() && Date.now() < deadline) {
        await sleep(SHUTDOWN_POLL_MS)
      }

      if (engine.hasRunningNodes()) {
        await engine.markShutdownNodes()
        await engine.suspendInterruptedRuns('graceful_shutdown_timeout')
      }

      process.exit(0)
    })()
  })
}

// ─── Public factory ───────────────────────────────────────────────────────────

/** Configuration options for the execution engine factory. */
export interface EngineConfig {
  /**
   * Database client. Required in production.
   * Defaults to the global Prisma singleton in non-test environments.
   */
  db?: ExecutorDb
  /**
   * Agent runner function. Required in production after T1.6.
   * For T1.4/T1.5 tests: pass a mock agent runner directly.
   */
  agentRunner?: AgentRunnerFn
  /**
   * Override max concurrent nodes per run.
   * If omitted: read from orchestrator.yaml (falls back to 4).
   * Pass an explicit value in tests to avoid filesystem reads.
   */
  maxConcurrentNodes?: number
  /**
   * Whether to register the SIGTERM shutdown handler.
   * Disable in tests to avoid polluting the process listener list.
   * @default true in production modes, false when db is injected (test hint)
   */
  registerShutdownHandler?: boolean
  /**
   * Whether to call recoverOrphans() on startup.
   * Disable in tests.
   * @default true in production modes
   */
  recoverOrphansOnStartup?: boolean
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
 * const engine = createExecutionEngine({ db: store, agentRunner: mockRunner, maxConcurrentNodes: 2 })
 */
export function createExecutionEngine(config: EngineConfig = {}): IExecutionEngine {
  const mode = process.env.DEPLOYMENT_MODE ?? 'docker'

  // In test contexts the caller always injects db — skip production defaults.
  const isTestContext = config.db != null

  const db = config.db ?? (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { db: prismaDb } = require('@/lib/db/client') as { db: ExecutorDb }
    return prismaDb
  })()

  const agentRunner: AgentRunnerFn = config.agentRunner ?? (async (_node, _handoffIn, _signal) => {
    throw new Error(
      'No agentRunner configured. Pass one via createExecutionEngine({ agentRunner }) or wire the real IAgentRunner (T1.6).',
    )
  })

  const maxConcurrentNodes = config.maxConcurrentNodes ?? (isTestContext ? 4 : loadMaxConcurrentNodes())

  let engine: IExecutionEngine

  switch (mode) {
    case 'docker':
    case 'electron':
    case 'test':
    default:
      engine = new CustomExecutor(db, agentRunner, maxConcurrentNodes)

    // T3.x stubs — will throw until implemented
    // case 'temporal': engine = new TemporalExecutor(db, agentRunner, maxConcurrentNodes); break
    // case 'restate':  engine = new RestateExecutor(db, agentRunner, maxConcurrentNodes); break
  }

  const registerShutdown = config.registerShutdownHandler ?? !isTestContext
  if (registerShutdown) {
    registerSigtermHandler(engine)
  }

  const runRecovery = config.recoverOrphansOnStartup ?? !isTestContext
  if (runRecovery) {
    void engine.recoverOrphans().catch((err: unknown) => {
      console.error('[harmoven] orphan recovery failed on startup:', err)
    })
  }

  return engine
}
