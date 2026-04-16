// lib/agents/scaffolding/smoke-test.agent.ts
// SmokeTestAgent — Amendment 73, Section 25.2.
//
// Position in DAG:
//   DevOps Agent → Smoke Test Agent → Human Gate (gate_before_delivery)
//
// What it does (§73.2):
//   1. Allocate a preview port (3100–3199)
//   2. docker compose up -d --build in the worktree
//   3. Wait up to 30s for the app to be healthy
//   4. Check core routes (/, /api/health, /login)
//   5. Run preview cascade (subdomain → subpath → screenshots)
//   6. On any route failure: RepairAgent → retry once (attempt 2)
//   7. docker compose stays UP during Human Gate; torn down on gate close
//
// Output: SmokeTestResult stored as node handoff_out
// Port:   kept alive — caller must call releasePreviewPort() on gate resolution

import path from 'path'
import fs   from 'fs'
import yaml from 'js-yaml'
import type { ILLMClient } from '@/lib/llm/interface'
import { safeBaseEnv } from '@/lib/utils/safe-env'
import { execFileAsync } from '@/lib/utils/exec-safe'
import { allocatePreviewPort, releasePreviewPort } from './port-allocator'
import {
  checkRoutes,
  resolvePreview,
  loadPreviewConfig,
} from './preview-cascade'
import type { PreviewResult, RouteCheck } from './preview-cascade'

// ─── Worktree safety guard ────────────────────────────────────────────────────
// Mirror of repair.agent.ts: all worktrees must live under WORKTREE_BASE_DIR.
// Prevents path traversal if metadata.worktree is tampered with.

function assertWorktreeIsSafe(worktree: string): string {
  const base = process.env.WORKTREE_BASE_DIR
  if (!base) {
    throw new Error(
      '[SmokeTestAgent] WORKTREE_BASE_DIR env variable is not set.',
    )
  }
  const baseResolved = path.resolve(base)
  const resolved     = path.resolve(worktree)
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new Error(
      `[SmokeTestAgent] Rejected worktree path "${worktree}" — must be under WORKTREE_BASE_DIR (${baseResolved}).`,
    )
  }
  return resolved
}

// ─── Compose file security validator ─────────────────────────────────────────
// Am.91 — Verify that the generated app's docker-compose.yml does not declare
// dangerous container capabilities before we execute `docker compose up`.
//
// Threat: a tampered DAG or a malicious compose template could declare
// `privileged: true`, `cap_add: ALL`, host network mode, or host PID namespace,
// allowing a container to escape to the Docker host.
//
// Defence-in-depth: Tecnativa docker-socket-proxy (in our own compose) already
// blocks exec+build from the Harmoven app, but a malicious compose file could
// map an explicit --cap-add at container-create time (CONTAINERS:1 allows POST
// /containers/create with unchecked body). This validator catches it before
// the request ever reaches the daemon.

const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

function findComposeFile(worktree: string): string | null {
  for (const name of COMPOSE_FILENAMES) {
    const candidate = path.join(worktree, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function validateComposeFile(worktree: string): void {
  const composePath = findComposeFile(worktree)
  if (!composePath) return   // no compose file — docker compose up will fail naturally

  let parsed: unknown
  try {
    const raw = fs.readFileSync(composePath, 'utf8')
    parsed = yaml.load(raw)
  } catch (err) {
    throw new Error(
      `[SmokeTestAgent] Could not parse compose file "${composePath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null) return

  const services = (parsed as Record<string, unknown>)['services']
  if (typeof services !== 'object' || services === null) return

  const violations: string[] = []

  for (const [svcName, svcRaw] of Object.entries(services as Record<string, unknown>)) {
    const svc = svcRaw as Record<string, unknown>
    const cfg = (svc?.['deploy'] as Record<string, unknown> | undefined) ?? {}

    // 1. Privileged mode — full host capability set
    if (svc?.['privileged'] === true) {
      violations.push(`service "${svcName}": privileged: true is not allowed`)
    }

    // 2. cap_add — adding specific Linux capabilities
    const capAdd = svc?.['cap_add']
    if (Array.isArray(capAdd) && capAdd.length > 0) {
      violations.push(`service "${svcName}": cap_add is not allowed (${(capAdd as string[]).join(', ')})`)
    }

    // 3. network_mode: host — bypasses Docker network isolation
    if (svc?.['network_mode'] === 'host') {
      violations.push(`service "${svcName}": network_mode: host is not allowed`)
    }

    // 4. pid: host — shares host PID namespace
    if (svc?.['pid'] === 'host') {
      violations.push(`service "${svcName}": pid: host is not allowed`)
    }

    // 5. ipc: host — shares host IPC namespace
    if (svc?.['ipc'] === 'host') {
      violations.push(`service "${svcName}": ipc: host is not allowed`)
    }

    // 6. security_opt: no-new-privileges:false — explicitly permits privilege escalation
    const secOpt = svc?.['security_opt']
    if (Array.isArray(secOpt)) {
      for (const opt of secOpt as string[]) {
        if (typeof opt === 'string' && opt === 'no-new-privileges:false') {
          violations.push(`service "${svcName}": security_opt no-new-privileges:false is not allowed`)
        }
      }
    }

    // 7. volumes binding /var/run/docker.sock or /proc or /sys (not via proxy)
    const volumes = svc?.['volumes']
    if (Array.isArray(volumes)) {
      for (const vol of volumes as unknown[]) {
        const src = typeof vol === 'string'
          ? vol.split(':')[0]
          : typeof vol === 'object' && vol !== null
            ? ((vol as Record<string, unknown>)['source'] as string | undefined)
            : undefined
        if (src && (
          src === '/var/run/docker.sock' ||
          src === '/proc' ||
          src.startsWith('/proc/') ||
          src === '/sys' ||
          src.startsWith('/sys/')
        )) {
          violations.push(`service "${svcName}": mounting "${src}" is not allowed`)
        }
      }
    }

    // Suppress TS "unused variable" warning — cfg is used as a guard for deploy key
    void cfg
  }

  if (violations.length > 0) {
    throw new Error(
      `[SmokeTestAgent] Compose file security check failed — ${violations.length} violation(s):\n` +
      violations.map(v => `  • ${v}`).join('\n')
    )
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SmokeTestInput {
  /** Absolute path to the generated app's worktree directory. */
  worktree:   string
  /** Run ID — used for port registry and subpath /preview/{runId}/ */
  run_id:     string
  /** Core routes to probe. Defaults: ['/', '/api/health', '/login'] */
  routes?:    string[]
  /** Max seconds to wait for the container to be healthy. Default: 30 */
  timeout_s?: number
}

export interface SmokeTestResult {
  success:         boolean
  preview:         PreviewResult
  routes_checked:  RouteCheck[]
  startup_time_ms: number
  attempt:         1 | 2
  repair_applied:  boolean
  error?:          string
}

// ─── Docker helpers ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000

async function dockerComposeUp(worktree: string, port: number): Promise<void> {
  try {
    await execFileAsync(
      'docker',
      ['compose', 'up', '-d', '--build'],
      {
        cwd:     worktree,
        timeout: 180_000,  // 3 min — build may be slow
        // SECURITY: never spread process.env — leaks DATABASE_URL, AUTH_SECRET, etc.
        // Use safeBaseEnv() (whitelist-only) and add only what docker compose needs.
        env: { ...safeBaseEnv(), APP_PORT: String(port) },
      },
    )
  } catch (err) {
    throw new Error(
      `[SmokeTestAgent] docker compose up failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function dockerComposeDown(worktree: string): Promise<void> {
  try {
    await execFileAsync(
      'docker',
      ['compose', 'down', '--remove-orphans'],
      { cwd: worktree, timeout: 60_000, env: safeBaseEnv() },
    )
  } catch {
    // Best-effort — don't throw if teardown fails
  }
}

/** Wait until localhost:{port}/ responds with any status, or throw on timeout. */
async function waitForHealthy(
  port:      number,
  timeoutMs: number,
  signal?:   AbortSignal,
): Promise<number> {
  const start = Date.now()
  const url   = `http://localhost:${port}/`
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      const res = await fetch(url, { signal, redirect: 'follow' })
      if (res.status < 600) return res.status   // any real response = healthy
    } catch {
      // Not ready yet — keep polling
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(
    `[SmokeTestAgent] Timed out waiting for app on port ${port} after ${timeoutMs / 1000}s`,
  )
}

// ─── Smoke test runner ────────────────────────────────────────────────────────

/**
 * Run the full smoke test + preview cascade for a scaffolded app.
 * Container is started and kept alive for the Human Gate.
 * Caller must call releasePreviewPort(run_id) when the gate is resolved.
 */
export async function runSmokeTest(
  input:   SmokeTestInput,
  llm:     ILLMClient,
  signal?: AbortSignal,
): Promise<SmokeTestResult> {
  const {
    worktree: rawWorktree,
    run_id,
    routes   = ['/', '/api/health', '/login'],
    timeout_s = 30,
  } = input

  // #4 — path traversal guard: validate worktree before any fs/exec call
  const worktree = assertWorktreeIsSafe(rawWorktree)

  // #5 — Am.91: validate compose file for dangerous capabilities before exec
  validateComposeFile(worktree)

  const timeoutMs = timeout_s * 1000
  const config    = loadPreviewConfig()

  // Step 1 — allocate port
  const port = await allocatePreviewPort(run_id)

  const startMs = Date.now()

  try {
    // Step 2 — start container
    await dockerComposeUp(worktree, port)

    // Step 3 — wait for healthy
    await waitForHealthy(port, timeoutMs, signal)

    const startupMs = Date.now() - startMs
    const localBase = `http://localhost:${port}`

    // Step 4 — check routes (attempt 1)
    const routesChecked1 = await checkRoutes(localBase, routes)
    const allOk1 = routesChecked1.every(r => r.ok || r.status === 0 /* absent route */)

    if (allOk1) {
      // Step 5 — preview cascade (attempt 1 success)
      const preview = await resolvePreview(config, run_id, port, worktree, llm, signal)
      return {
        success:         true,
        preview,
        routes_checked:  routesChecked1,
        startup_time_ms: startupMs,
        attempt:         1,
        repair_applied:  false,
      }
    }

    // Step 6 — route check failed: RepairAgent → retry
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    let routesChecked2 = routesChecked1
    let repairApplied  = false

    try {
      // RepairAgent patches app config for broken routes (not just subpath issues)
      const { repairForSubpath } = await import('./repair.agent')
      await repairForSubpath(worktree, `/preview/${run_id}/`, llm, signal)
      repairApplied = true

      // Restart container with patched code
      await dockerComposeDown(worktree)
      await dockerComposeUp(worktree, port)
      await waitForHealthy(port, timeoutMs, signal)

      routesChecked2 = await checkRoutes(localBase, routes)
    } catch (repairErr) {
      console.warn('[SmokeTestAgent] RepairAgent failed:', repairErr)
      // Fall through — produce partial result with screenshots
    }

    const allOk2 = routesChecked2.every(r => r.ok || r.status === 0)

    // Step 5 (attempt 2) — preview cascade
    const preview = await resolvePreview(config, run_id, port, worktree, llm, signal)

    return {
      success:         allOk2,
      preview,
      routes_checked:  routesChecked2,
      startup_time_ms: Date.now() - startMs,
      attempt:         2,
      repair_applied:  repairApplied,
      ...(!allOk2 && {
        error: `Route checks failed after repair: ${routesChecked2.filter(r => !r.ok).map(r => r.path).join(', ')}`,
      }),
    }
  } catch (err) {
    // Fatal error — tear down container and release port
    await dockerComposeDown(worktree)
    await releasePreviewPort(run_id)

    const message = err instanceof Error ? err.message : String(err)
    return {
      success:         false,
      preview:         { type: 'screenshots', url: null, screenshots: [] },
      routes_checked:  [],
      startup_time_ms: Date.now() - startMs,
      attempt:         1,
      repair_applied:  false,
      error:           message,
    }
  }
}

// ─── Teardown helper (called on Human Gate resolution) ────────────────────────

/**
 * Tear down the preview container and release the allocated port.
 * Must be called when the Human Gate is approved or abandoned.
 */
export async function teardownPreview(worktree: string, runId: string): Promise<void> {
  await dockerComposeDown(worktree)
  await releasePreviewPort(runId)
}
