// lib/llm/plugin-subprocess-bridge.ts
// Parent-side bridge implementing ILlmProviderPlugin via subprocess stdio/IPC.
//
// ── Isolation model ───────────────────────────────────────────────────────────
// Each installed LLM plugin runs in a separate child_process spawned with a
// filtered copy of process.env that explicitly excludes server secrets:
//   ENCRYPTION_KEY, AUTH_SECRET, DATABASE_URL, POSTGRES_* and similar.
//
// API keys the plugin needs are still forwarded from the parent env, OR
// pre-resolved from api_key_enc (decrypted in the parent) and injected into
// the child process via the request profile (profile.api_key_resolved).
//
// This mirrors the same OS-level isolation used by MCP skill processes.
//
// ── Protocol ─────────────────────────────────────────────────────────────────
// Newline-delimited JSON on stdin (parent→child) / stdout (child→parent).
// See lib/llm/plugin-subprocess-worker.cjs for the child-side implementation.
//
// ── Plugin authoring convention ───────────────────────────────────────────────
// register() MUST return the ILlmProviderPlugin object so the bridge can access
// it without relying on the server's registerLlmPlugin registry being present
// inside the subprocess.

import { spawn }       from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path            from 'node:path'
import { randomUUID }  from 'node:crypto'
import type { ILlmProviderPlugin } from './plugin-loader'
import type { LlmProfileConfig }   from './profiles'
import type { ChatMessage, ChatOptions, ChatResult } from './interface'
import { decryptLlmKey }           from '@/lib/utils/llm-key-crypto'

// ── Constants ──────────────────────────────────────────────────────────────────

/** Absolute path to the worker CJS entry point. */
const WORKER_PATH = path.resolve(process.cwd(), 'lib', 'llm', 'plugin-subprocess-worker.cjs')

/** Timeout for the ready + ping + get_profiles handshake on startup. */
const VERIFY_TIMEOUT_MS  = 8_000

/** Per-request timeout forwarded to the child as timeout_ms. */
const REQUEST_TIMEOUT_MS = 120_000   // 2 minutes

/** Max automatic subprocess restarts before marking the plugin permanently dead. */
const MAX_RESTARTS = 3

/**
 * Server-side env vars that must NEVER be forwarded to plugin subprocesses.
 * These carry cryptographic key material or database credentials.
 */
const BLOCKED_ENV_VARS = new Set([
  'ENCRYPTION_KEY',
  'AUTH_SECRET',
  'BETTER_AUTH_SECRET',
  'DATABASE_URL',
  'SHADOW_DATABASE_URL',
  'DIRECT_DATABASE_URL',
  'SESSION_SECRET',
  'JWT_SECRET',
  'NEXTAUTH_SECRET',
  'CONFIG_GIT_DIR',
  'CONFIG_GIT_REMOTE',
])

/** Env-var prefixes that are always blocked (server internal / DB credentials). */
const BLOCKED_ENV_PREFIXES: readonly string[] = [
  'POSTGRES_',
  'PG_',
  'NEXT_INTERNAL_',
  'BETTER_AUTH_',
]

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a filtered copy of process.env, excluding server secrets. */
function buildSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (BLOCKED_ENV_VARS.has(key)) continue
    if (BLOCKED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) continue
    env[key] = value
  }
  return env
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve:  (result: ChatResult) => void
  reject:   (err: Error)         => void
  onChunk?: (chunk: string)      => void
  timer:    ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?:  AbortSignal
}

// ── PluginSubprocessBridge ─────────────────────────────────────────────────────

/**
 * Spawns a plugin.cjs bundle in an isolated child process and proxies
 * chat/stream requests over newline-delimited JSON stdio.
 *
 * Implements ILlmProviderPlugin so it can be dropped into the existing
 * plugin registry without changes to DirectLLMClient.
 */
export class PluginSubprocessBridge implements ILlmProviderPlugin {
  readonly providerId: string
  private _profiles:   LlmProfileConfig[] = []
  private bundlePath:  string
  private subEnv:      Record<string, string>
  private child:       ChildProcess | null = null
  private pending:     Map<string, PendingRequest>     = new Map()
  private pingWaiters: Map<string, () => void>         = new Map()
  private profWaiters: Map<string, (p: LlmProfileConfig[]) => void> = new Map()
  private readyHooks:  Array<() => void>               = []
  private isReady:     boolean  = false
  private restarts:    number   = 0
  private dead:        boolean  = false

  get profiles(): LlmProfileConfig[] {
    return this._profiles
  }

  constructor(bundlePath: string, providerId: string) {
    this.bundlePath = bundlePath
    this.providerId = providerId
    this.subEnv     = buildSubprocessEnv()
    this._spawnChild()
  }

  // ── Subprocess lifecycle ────────────────────────────────────────────────────

  private _spawnChild(): void {
    if (this.dead) return
    this.isReady = false

    const child = spawn(
      process.execPath,
      [WORKER_PATH, this.bundlePath, this.providerId],
      // Cast env: NodeJS.ProcessEnv allows string|undefined values; our filtered env
      // is all-defined strings which satisfies the contract at runtime.
      { stdio: ['pipe', 'pipe', 'pipe'], env: this.subEnv as NodeJS.ProcessEnv, detached: false },
    )
    this.child = child

    // ── stdout: newline-delimited JSON ────────────────────────────────────────
    let stdoutBuf = ''
    child.stdout!.on('data', (data: Buffer) => {
      stdoutBuf += data.toString('utf8')
      let idx: number
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf  = stdoutBuf.slice(idx + 1)
        if (line) this._handleLine(line)
      }
    })

    // ── stderr: forward to server log ─────────────────────────────────────────
    let stderrBuf = ''
    child.stderr!.on('data', (data: Buffer) => {
      stderrBuf += data.toString('utf8')
      const lines = stderrBuf.split('\n')
      stderrBuf   = lines.pop() ?? ''
      for (const l of lines) {
        if (l.trim()) console.log(`[plugin-subprocess:${this.providerId}]`, l)
      }
    })

    child.on('error', (err: Error) => {
      console.error(`[plugin-subprocess:${this.providerId}] spawn error:`, err)
    })

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      console.warn(
        `[plugin-subprocess:${this.providerId}] exited ` +
        `(code=${code ?? 'null'} signal=${signal ?? 'null'})`,
      )
      this.child   = null
      this.isReady = false

      // Reject all in-flight requests
      const snapshot = new Map(this.pending)
      this.pending.clear()
      for (const [, req] of snapshot) {
        clearTimeout(req.timer)
        if (req.signal && req.onAbort) req.signal.removeEventListener('abort', req.onAbort)
        req.reject(new Error(`[plugin-subprocess:${this.providerId}] process exited unexpectedly`))
      }

      if (!this.dead && this.restarts < MAX_RESTARTS) {
        this.restarts++
        console.info(
          `[plugin-subprocess:${this.providerId}] restarting ` +
          `(${this.restarts}/${MAX_RESTARTS})…`,
        )
        setTimeout(() => this._spawnChild(), 500)
      } else if (!this.dead) {
        this.dead = true
        console.error(
          `[plugin-subprocess:${this.providerId}] max restarts reached — plugin disabled`,
        )
      }
    })
  }

  // ── Message routing ─────────────────────────────────────────────────────────

  private _handleLine(line: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(line) as Record<string, unknown> } catch { return }

    const { type, id } = msg as { type: string; id: string }

    if (type === 'ready') {
      this.isReady = true
      const hooks = this.readyHooks.splice(0)
      for (const h of hooks) h()
      return
    }

    if (type === 'pong') {
      this.pingWaiters.get(id)?.()
      this.pingWaiters.delete(id)
      return
    }

    if (type === 'profiles') {
      this.profWaiters.get(id)?.(msg.profiles as LlmProfileConfig[])
      this.profWaiters.delete(id)
      return
    }

    const req = this.pending.get(id)
    if (!req) return

    if (type === 'chunk') {
      req.onChunk?.(msg.chunk as string)
      return
    }

    // Final response — result or error
    clearTimeout(req.timer)
    if (req.signal && req.onAbort) req.signal.removeEventListener('abort', req.onAbort)
    this.pending.delete(id)

    if (type === 'result') {
      req.resolve({
        content:   msg.content   as string,
        tokensIn:  msg.tokensIn  as number,
        tokensOut: msg.tokensOut as number,
        model:     msg.model     as string,
        costUsd:   msg.costUsd   as number,
        ...(msg.tool_calls_trace
          ? { tool_calls_trace: msg.tool_calls_trace as ChatResult['tool_calls_trace'] }
          : undefined),
      })
    } else if (type === 'error') {
      req.reject(new Error(msg.message as string))
    }
  }

  // ── Send helper ─────────────────────────────────────────────────────────────

  private _send(obj: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) {
      throw new Error(`[plugin-subprocess:${this.providerId}] stdin not writable`)
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  // ── Startup handshake ───────────────────────────────────────────────────────

  /**
   * Wait for the subprocess to signal `ready`, then exchange ping + get_profiles.
   * Call this once immediately after construction.
   * Throws if the subprocess does not respond within VERIFY_TIMEOUT_MS.
   */
  async verify(): Promise<void> {
    if (this.dead) throw new Error(`[plugin-subprocess:${this.providerId}] plugin marked dead`)

    // 1. Await 'ready' event ───────────────────────────────────────────────────
    await new Promise<void>((resolve, reject) => {
      if (this.isReady) { resolve(); return }
      const timer = setTimeout(() => {
        const idx = this.readyHooks.indexOf(resolve)
        if (idx !== -1) this.readyHooks.splice(idx, 1)
        reject(new Error(`[plugin-subprocess:${this.providerId}] ready timeout`))
      }, VERIFY_TIMEOUT_MS)
      this.readyHooks.push(() => { clearTimeout(timer); resolve() })
    })

    // 2. Ping round-trip ───────────────────────────────────────────────────────
    const pingId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pingWaiters.delete(pingId)
        reject(new Error(`[plugin-subprocess:${this.providerId}] ping timeout`))
      }, VERIFY_TIMEOUT_MS)
      this.pingWaiters.set(pingId, () => { clearTimeout(timer); resolve() })
      this._send({ type: 'ping', id: pingId })
    })

    // 3. Fetch plugin profiles ─────────────────────────────────────────────────
    const profId = randomUUID()
    const profiles = await new Promise<LlmProfileConfig[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.profWaiters.delete(profId)
        reject(new Error(`[plugin-subprocess:${this.providerId}] get_profiles timeout`))
      }, VERIFY_TIMEOUT_MS)
      this.profWaiters.set(profId, (p) => { clearTimeout(timer); resolve(p) })
      this._send({ type: 'get_profiles', id: profId })
    })

    this._profiles = profiles
    console.info(
      `[plugin-subprocess:${this.providerId}] verified — ` +
      `${profiles.length} profile(s): ${profiles.map(p => p.id).join(', ')}`,
    )
  }

  // ── API-key resolution ──────────────────────────────────────────────────────

  /**
   * Resolve the plain-text API key for a profile IN THE PARENT PROCESS.
   * The parent has ENCRYPTION_KEY; the child does not.
   */
  private _resolveApiKey(profile: LlmProfileConfig): string | undefined {
    if (profile.api_key_enc) {
      return decryptLlmKey(profile.api_key_enc) ?? undefined
    }
    if (profile.api_key_env) {
      return process.env[profile.api_key_env]
    }
    return undefined
  }

  /**
   * Build a version of the profile that is safe to send over stdio:
   * - api_key_enc cleared (never forward encrypted key material)
   * - api_key_resolved set so the worker can inject it into process.env
   */
  private _sanitizeProfile(profile: LlmProfileConfig): Record<string, unknown> {
    const resolved = this._resolveApiKey(profile)
    return {
      ...profile,
      api_key_enc:      undefined,   // strip encrypted ciphertext
      api_key_resolved: resolved,    // pre-resolved plaintext (may be undefined)
    }
  }

  /** Strip non-serializable ChatOptions fields before sending over stdio. */
  private _serializeOptions(options: ChatOptions): Record<string, unknown> {
    const { signal, toolExecutor, selectionContext, ...safe } = options
    return { ...safe, timeout_ms: REQUEST_TIMEOUT_MS }
  }

  // ── ILlmProviderPlugin ──────────────────────────────────────────────────────

  async chat(
    profile:  LlmProfileConfig,
    messages: ChatMessage[],
    options:  ChatOptions,
  ): Promise<ChatResult> {
    if (this.dead) throw new Error(`[plugin-subprocess:${this.providerId}] plugin disabled`)
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const id = randomUUID()
    return new Promise<ChatResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[plugin-subprocess:${this.providerId}] chat timeout`))
      }, REQUEST_TIMEOUT_MS + 5_000)

      const onAbort = (): void => {
        this.pending.get(id) && (() => {
          clearTimeout(this.pending.get(id)!.timer)
          this.pending.delete(id)
        })()
        try { this._send({ type: 'cancel', id }) } catch { /* ignore */ }
        reject(new DOMException('Aborted', 'AbortError'))
      }

      this.pending.set(id, { resolve, reject, timer, onAbort, signal: options.signal })
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        this._send({
          type:    'chat',
          id,
          profile: this._sanitizeProfile(profile),
          messages,
          options: this._serializeOptions(options),
        })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        options.signal?.removeEventListener('abort', onAbort)
        reject(err as Error)
      }
    })
  }

  async stream(
    profile:  LlmProfileConfig,
    messages: ChatMessage[],
    options:  ChatOptions,
    onChunk:  (chunk: string) => void,
  ): Promise<ChatResult> {
    if (this.dead) throw new Error(`[plugin-subprocess:${this.providerId}] plugin disabled`)
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const id = randomUUID()
    return new Promise<ChatResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[plugin-subprocess:${this.providerId}] stream timeout`))
      }, REQUEST_TIMEOUT_MS + 5_000)

      const onAbort = (): void => {
        this.pending.get(id) && (() => {
          clearTimeout(this.pending.get(id)!.timer)
          this.pending.delete(id)
        })()
        try { this._send({ type: 'cancel', id }) } catch { /* ignore */ }
        reject(new DOMException('Aborted', 'AbortError'))
      }

      this.pending.set(id, { resolve, reject, onChunk, timer, onAbort, signal: options.signal })
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        this._send({
          type:    'stream',
          id,
          profile: this._sanitizeProfile(profile),
          messages,
          options: this._serializeOptions(options),
        })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        options.signal?.removeEventListener('abort', onAbort)
        reject(err as Error)
      }
    })
  }

  // ── Shutdown ────────────────────────────────────────────────────────────────

  /** Gracefully terminate the subprocess (close stdin, then SIGTERM after 500 ms). */
  dispose(): void {
    if (this.dead) return
    this.dead = true
    if (this.child) {
      try { this.child.stdin?.end() } catch { /* ignore */ }
      setTimeout(() => { if (this.child) this.child.kill('SIGTERM') }, 500)
    }
  }
}
