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
import type { IProjectEventBus } from '@/lib/events/project-event-bus.interface'
import { CustomExecutor } from '@/lib/execution/custom/executor'
import { makeAgentRunner } from '@/lib/agents/runner'
import { createLLMClient } from '@/lib/llm/client'
import { resumeSuspendedRunsFromCrash, resetStaleRunningRuns } from '@/lib/execution/custom/crash-recovery'
import { db as _prismaDb } from '@/lib/db/client'
import { projectEventBus as _defaultEventBus } from '@/lib/events/project-event-bus.factory'

// ─── ExecutorDb adapter — wraps PrismaClient and adds findOrphaned ────────────
/**
 * Lazy ExecutorDb implementation for production.
 * Uses the module-level `_prismaDb` import (same pattern as API routes) to ensure
 * the Proxy is properly resolved. Adds findOrphaned via a raw findMany call.
 */
class PrismaExecutorDb implements ExecutorDb {
  get run(): ExecutorDb['run'] {
    return {
      findUniqueOrThrow: (args) => (_prismaDb.run.findUniqueOrThrow as Function)(args),
      update:            (args) => (_prismaDb.run.update            as Function)(args),
      create:            (args) => (_prismaDb.run.create            as Function)(args),
    }
  }
  get humanGate() { return _prismaDb.humanGate as unknown as ExecutorDb['humanGate'] }
  get auditLog()  { return _prismaDb.auditLog  as unknown as ExecutorDb['auditLog'] }
  get runDependency(): ExecutorDb['runDependency'] {
    return {
      create: (args) => (_prismaDb.runDependency.create as Function)(args),
    }
  }

  get handoff(): ExecutorDb['handoff'] {
    return {
      create:    (args)  => (_prismaDb.handoff.create    as Function)(args),
      aggregate: (args)  => (_prismaDb.handoff.aggregate as Function)(args),
      /**
       * sequence_number is now @default(autoincrement()) — PostgreSQL assigns
       * it atomically via a SEQUENCE. No application-level mutex needed.
       */
      createAtomic: (data) => (_prismaDb.handoff.create as Function)({ data }),
    }
  }

  get node(): ExecutorDb['node'] {
    return {
      findMany:     (args) => (_prismaDb.node.findMany   as Function)(args),
      create:       (args) => (_prismaDb.node.create     as Function)(args),
      update:       (args) => (_prismaDb.node.update     as Function)(args),
      updateMany:   (args) => (_prismaDb.node.updateMany as Function)(args),
      createMany:   (args) => (_prismaDb.node.createMany as Function)(args),
      /** Return all RUNNING nodes with last_heartbeat before the given threshold. */
      findOrphaned: ({ before }: { before: Date }) =>
        (_prismaDb.node.findMany as Function)({
          where: { status: 'RUNNING', last_heartbeat: { lt: before } },
        }),
    }
  }
}

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
  } catch (err) {
    // ENOENT is expected when the file is intentionally absent — use the default silently.
    // Any other error (parse failure, permission denied) should be visible.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[harmoven] orchestrator.yaml could not be loaded — using default max_concurrent_nodes=4:', err)
    }
    return 4
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

/** Max time (ms) to wait for in-flight nodes to finish before forcibly marking them down. */
const SHUTDOWN_TIMEOUT_MS = 30_000
const SHUTDOWN_POLL_MS     = 200

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** How often to run periodic orphan recovery (spec §34.3: "every 5 min"). */
const ORPHAN_CRON_INTERVAL_MS = 5 * 60 * 1_000

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
  /**
   * Event bus for emitting run/node SSE events.
   * If omitted in production: the factory injects the global `projectEventBus` singleton.
   * Pass undefined explicitly in tests to disable event emission.
   */
  eventBus?: IProjectEventBus | null
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

  const db = config.db ?? new PrismaExecutorDb()

  const agentRunner: AgentRunnerFn = config.agentRunner ?? (() => {
    // Production code must go through getExecutionEngine() which awaits
    // createLLMClient() and passes the result here. Reaching this branch
    // without an agentRunner is a programming error — fail loudly.
    throw new Error(
      '[createExecutionEngine] No agentRunner provided. ' +
      'Use getExecutionEngine() for production — it awaits createLLMClient() before constructing the engine.',
    )
  })()

  const maxConcurrentNodes = config.maxConcurrentNodes ?? (isTestContext ? 4 : loadMaxConcurrentNodes())

  // Resolve event bus: use injected value (null = explicit disable), else production singleton.
  let eventBus: IProjectEventBus | undefined
  if (config.eventBus === null) {
    eventBus = undefined  // explicitly disabled (tests)
  } else if (config.eventBus != null) {
    eventBus = config.eventBus
  } else if (!isTestContext) {
    // Production default: use the module-level import of the singleton.
    eventBus = _defaultEventBus
  }

  let engine: IExecutionEngine

  switch (mode) {
    case 'docker':
    case 'electron':
    case 'test':
    default:
      engine = new CustomExecutor(db, agentRunner, maxConcurrentNodes, eventBus ?? undefined)

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
    // Run once on startup to recover nodes from a previous crash.
    void engine.recoverOrphans().catch((err: unknown) => {
      console.error('[harmoven] orphan recovery failed on startup:', err)
    })

    // Repeat every 5 min (spec §34.3: "startup + every 5 min").
    // Unref so the interval does not prevent process exit.
    const cron = setInterval(() => {
      void engine.recoverOrphans().catch((err: unknown) => {
        console.error('[harmoven] periodic orphan recovery failed:', err)
      })
    }, ORPHAN_CRON_INTERVAL_MS)
    cron.unref()

    // Resume SUSPENDED runs from a previous graceful or unclean shutdown.
    // Must run after recoverOrphans() so that orphaned nodes have been reset.
    // Am.34.3b — "resume RUNNING runs on startup".
    void resumeSuspendedRunsFromCrash(engine).catch((err: unknown) => {
      console.error('[harmoven] crash recovery (resume suspended) failed on startup:', err)
    })

    // Reset stale RUNNING runs (engine lost mid-launch, all nodes still PENDING).
    void resetStaleRunningRuns(engine).catch((err: unknown) => {
      console.error('[harmoven] stale RUNNING run reset failed on startup:', err)
    })
  }

  return engine
}

// ─── Process-lifetime singleton (T3.2 / Am.65) ───────────────────────────────
//
// API route handlers (pause/resume/inject/interrupt/gate) must call the SAME
// executor instance that is running the nodes, so that per-node AbortControllers
// and other in-memory state (pausedRunIds, nodeRunId …) are shared.
//
// In Next.js the module cache is NOT preserved across hot-reloads in dev; using
// globalThis as the carrier ensures the singleton survives within a given process
// without introducing circular imports.
//
// This is intentionally NOT exported to test files — tests call createExecutionEngine()
// directly and inject their own mocks.

declare global {
  // eslint-disable-next-line no-var
  var __harmoven_execution_engine: IExecutionEngine | undefined
}

/**
 * Returns the process-lifetime IExecutionEngine singleton.
 * Lazily initialises it on first call using the production defaults (DEPLOYMENT_MODE,
 * orchestrator.yaml, db singleton, LLM client, event bus).
 *
 * All API route handlers that need to interact with the running executor should call
 * this function instead of createExecutionEngine().
 *
 * @throws if called in a test context — tests must use createExecutionEngine() with mocks.
 */
export async function getExecutionEngine(): Promise<IExecutionEngine> {
  // If the singleton is missing a method defined in IExecutionEngine, the cached
  // instance is stale (e.g. created before a new method was added via HMR in dev).
  // Recreate it so callers never receive a partially-functional engine.
  const stale = globalThis.__harmoven_execution_engine
    && !('replayNode' in globalThis.__harmoven_execution_engine)
  if (!globalThis.__harmoven_execution_engine || stale) {
    if (stale) {
      console.warn('[harmoven] execution engine singleton is stale (missing replayNode) — recreating')
    }
    // createLLMClient() is async — it reads DB and seeds built-in profiles.
    // Must be awaited before constructing the engine so the agentRunner has a
    // fully-loaded ILLMClient backed by live DB profiles.
    const llm = await createLLMClient()
    globalThis.__harmoven_execution_engine = createExecutionEngine({
      agentRunner: makeAgentRunner(llm),
    })
  }
  return globalThis.__harmoven_execution_engine
}

