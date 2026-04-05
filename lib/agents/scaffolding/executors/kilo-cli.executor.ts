// lib/agents/scaffolding/executors/kilo-cli.executor.ts
// KiloCliExecutor — Kilo Code CLI execution backend (Am.72.4).
//
// Activation requires (Expert Mode only):
//   1. Project in Expert Mode
//   2. 'kilo-cli' skill admin-approved in the MCP Skills panel
//   3. kilocode CLI installed: npm install -g @kilocode/cli
//   4. execution_backend: kilo_cli in project config
//
// KiloCliExecutor.isAvailable() checks `kilocode --version` in PATH.
// KiloCliExecutor.execute() writes a worktree-scoped permission config,
//   invokes `kilocode --auto --json`, and parses the JSON output.
// Full spec: TECHNICAL.md Section 24.3, Amendment 72.4.
//
// The factory (layer-agent-executor.factory.ts) loads this file via dynamic import
// (Am.95.2), so it is never bundled into the process unless kilo_cli is requested.
//
// SECURITY:
//   - PATH is sanitised (safeBaseEnv) before passing to execFile — no shell injection.
//   - The permissions file is written with a safe allowlist — no shell metacharacters.
//   - Stdout is capped at MAX_OUTPUT_BYTES to reject oversized / malicious output.
//   - kilocode runs inside the worktree — no access outside worktree_path by default.
//   - spawn timeout is enforced (KILO_TIMEOUT_MS) to prevent hung processes.

import fs   from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { promisify }       from 'util'

import type {
  ILayerAgentExecutor,
  LayerAgentInput,
  LayerAgentOutput,
} from '../layer-agent-executor.interface'

const execFileAsync = promisify(execFile)

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on stdout captured from kilocode — prevents memory exhaustion. */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024  // 5 MB

/** Per-invocation wall-clock timeout. Prevents hung CLI processes. */
const KILO_TIMEOUT_MS = parseInt(process.env.KILO_TIMEOUT_MS ?? '300000', 10) || 300_000

/** Permissions file placed in the worktree root before invocation. */
const PERMISSIONS_FILENAME = '.harmoven-permissions.json'

// ─── Kilo CLI JSON output shape ───────────────────────────────────────────────

interface KiloJsonOutput {
  success:        boolean
  files_modified: string[]
  files_created:  string[]
  tests_passed:   boolean | null
  cost_usd:       number
  error?:         string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal, safe environment for spawning kilocode.
 * Inherits PATH and HOME (needed for CLI tools) but strips any secrets
 * that might be in the parent process env (DATABASE_URL, AUTH_SECRET, etc.).
 *
 * SECURITY: Allowlist approach — explicitly include only what kilocode needs.
 */
function safeBaseEnv(): NodeJS.ProcessEnv {
  const ALLOWED_KEYS = new Set([
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TERM', 'COLORTERM', 'NO_COLOR',
    // Kilocode may need the LLM API provider keys set via its own config,
    // but those are in ~/.kilocode/config, not injected here.
  ])
  const env: { [key: string]: string | undefined } = {}
  for (const key of ALLOWED_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env as NodeJS.ProcessEnv
}

/**
 * Allowlist of tools that Kilo Code may use inside the worktree.
 * Stored as JSON in the worktree root; kilocode reads this file to enforce
 * its own capabilities guard. Harmoven does NOT rely solely on this file
 * for security — kilocode runs in an isolated worktree.
 */
function buildPermissionsConfig(input: LayerAgentInput): object {
  return {
    version:    1,
    run_id:     input.run_id,
    node_id:    input.node_id,
    layer:      input.layer,
    budget_usd: input.budget_usd,
    allow_tools: [
      'read_file', 'write_file', 'list_directory',
      'search_files', 'execute_command',
    ],
    deny_tools: [
      'browser', 'mcp_server', 'new_task',
    ],
    // Constrain filesystem access to the worktree.
    // kilocode respects this directive (Am.95.3).
    working_directory: input.worktree_path,
  }
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export class KiloCliExecutor implements ILayerAgentExecutor {
  readonly name = 'kilo_cli' as const

  /**
   * Returns true if `kilocode` is found in PATH and responds to --version.
   * The factory falls back to LLMDirectExecutor when isAvailable() returns false.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('kilocode', ['--version'], {
        env:     safeBaseEnv(),
        timeout: 5000,
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Execute a layer agent via the Kilo Code CLI.
   *
   * Steps:
   *   1. Write .harmoven-permissions.json in the worktree root (allowlist).
   *   2. Spawn `kilocode --auto --json` with the spec piped via stdin.
   *   3. Capture stdout (capped at MAX_OUTPUT_BYTES), parse JSON.
   *   4. Return a structured LayerAgentOutput.
   */
  async execute(input: LayerAgentInput): Promise<LayerAgentOutput> {
    const startMs = Date.now()

    // ── 0. WORKTREE_BASE_DIR guard — mirrors repair.agent.ts / smoke-test.agent.ts.
    //   Must run before any fs/exec operation to prevent path traversal outside the
    //   allowed base directory via a manipulated input.worktree_path.
    const worktreeBase = process.env.WORKTREE_BASE_DIR
    if (!worktreeBase) {
      throw new Error(
        '[KiloCliExecutor] WORKTREE_BASE_DIR env variable is not set. '
        + 'Set it to the parent directory of all generated app worktrees.',
      )
    }
    const baseResolved     = path.resolve(worktreeBase)
    const worktreeResolved = path.resolve(input.worktree_path)
    if (
      !worktreeResolved.startsWith(baseResolved + path.sep)
      && worktreeResolved !== baseResolved
    ) {
      throw new Error(
        `[KiloCliExecutor] Rejected worktree path "${input.worktree_path}" `
        + `— must be under WORKTREE_BASE_DIR (${baseResolved}).`,
      )
    }

    // ── 1. Write permissions config ────────────────────────────────────────
    const permissionsPath = path.join(worktreeResolved, PERMISSIONS_FILENAME)
    try {
      fs.writeFileSync(
        permissionsPath,
        JSON.stringify(buildPermissionsConfig(input), null, 2),
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (e) {
      return {
        success:        false,
        files_modified: [],
        files_created:  [],
        tests_passed:   null,
        cost_usd:       0,
        duration_ms:    Date.now() - startMs,
        raw_output:     '',
        error:          `Failed to write permissions config: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    // ── 2. Spawn kilocode ──────────────────────────────────────────────────
    let rawOutput = ''
    let spawnError: Error | null = null

    try {
      rawOutput = await spawnKilocode(input, KILO_TIMEOUT_MS)
    } catch (e) {
      spawnError = e instanceof Error ? e : new Error(String(e))
    } finally {
      // Clean up permissions file regardless of outcome.
      try { fs.unlinkSync(permissionsPath) } catch { /* ignore */ }
    }

    if (spawnError) {
      return {
        success:        false,
        files_modified: [],
        files_created:  [],
        tests_passed:   null,
        cost_usd:       0,
        duration_ms:    Date.now() - startMs,
        raw_output:     rawOutput,
        error:          spawnError.message,
      }
    }

    // ── 3. Parse JSON output ───────────────────────────────────────────────
    let parsed: KiloJsonOutput
    try {
      // kilocode may emit progress lines before the final JSON object.
      // Extract the last complete JSON object from stdout.
      const jsonMatch = rawOutput.match(/(\{[\s\S]*\})\s*$/)
      if (!jsonMatch) throw new Error('No JSON object found in kilocode output')
      parsed = JSON.parse(jsonMatch[1]!) as KiloJsonOutput
    } catch (e) {
      return {
        success:        false,
        files_modified: [],
        files_created:  [],
        tests_passed:   null,
        cost_usd:       0,
        duration_ms:    Date.now() - startMs,
        raw_output:     rawOutput,
        error:          `Failed to parse kilocode JSON output: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    return {
      success:        parsed.success ?? false,
      files_modified: Array.isArray(parsed.files_modified) ? parsed.files_modified : [],
      files_created:  Array.isArray(parsed.files_created)  ? parsed.files_created  : [],
      tests_passed:   parsed.tests_passed ?? null,
      cost_usd:       typeof parsed.cost_usd === 'number' ? parsed.cost_usd : 0,
      duration_ms:    Date.now() - startMs,
      raw_output:     rawOutput,
      error:          parsed.error,
    }
  }
}

// ─── kilocode spawn helper ────────────────────────────────────────────────────

/**
 * Spawn `kilocode --auto --json` with the spec piped to stdin.
 * Captures stdout up to MAX_OUTPUT_BYTES; enforces KILO_TIMEOUT_MS.
 * Rejects with an error if the process exits non-zero.
 */
function spawnKilocode(input: LayerAgentInput, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kilocode',
      [
        '--auto',
        '--json',
        '--worktree', input.worktree_path,
        '--layer',    input.layer,
        '--run-id',   input.run_id,
        '--node-id',  input.node_id,
        '--budget',   String(input.budget_usd),
      ],
      {
        cwd:   input.worktree_path,
        env:   safeBaseEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    // Write spec to stdin then close it.
    child.stdin.write(input.spec, 'utf8')
    child.stdin.end()

    let stdoutBuf = ''
    let stderrBuf = ''
    let bytesRead = 0

    child.stdout.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length
      if (bytesRead <= MAX_OUTPUT_BYTES) {
        stdoutBuf += chunk.toString('utf8')
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8').slice(0, 4096)
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
      reject(new Error(`kilocode timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdoutBuf)
      } else {
        reject(new Error(
          `kilocode exited with code ${code}. stderr: ${stderrBuf.slice(0, 500)}`,
        ))
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}
