// lib/llm/plugin-subprocess-worker.cjs
// Subprocess entry point for LLM provider plugins.
// Spawned by PluginSubprocessBridge with:
//   argv[2] = absolute path to plugin.cjs bundle
//   argv[3] = provider_id (for logging)
//
// ── Protocol (newline-delimited JSON on stdin/stdout) ─────────────────────────
//   Parent → Child:
//     { type: 'ping',         id }
//     { type: 'get_profiles', id }
//     { type: 'chat',         id, profile, messages, options }
//     { type: 'stream',       id, profile, messages, options }
//     { type: 'cancel',       id }
//   Child → Parent:
//     { type: 'ready' }       (sent once after plugin loads successfully)
//     { type: 'pong',         id }
//     { type: 'profiles',     id, profiles: LlmProfileConfig[] }
//     { type: 'result',       id, content, tokensIn, tokensOut, model, costUsd }
//     { type: 'chunk',        id, chunk }
//     { type: 'error',        id, message }
//
// ── Security ──────────────────────────────────────────────────────────────────
// Spawned with filtered env: ENCRYPTION_KEY, AUTH_SECRET, DATABASE_URL, and
// other server secrets are explicitly excluded by PluginSubprocessBridge.
// The parent pre-resolves API keys and passes them via profile.api_key_resolved
// so the child never needs ENCRYPTION_KEY.

'use strict'

const readline = require('node:readline')
const path     = require('node:path')

const bundlePath = process.argv[2]
const providerId = process.argv[3] ?? 'unknown'
const tag        = `[plugin-worker:${providerId}]`

if (!bundlePath) {
  process.stderr.write(`${tag} ERROR: No bundle path provided as argv[2]\n`)
  process.exit(1)
}

// ── Load plugin bundle ────────────────────────────────────────────────────────

let plugin = null

try {
  const resolvedBundle = path.resolve(bundlePath)
  const mod            = require(resolvedBundle) // eslint-disable-line @typescript-eslint/no-require-imports

  // Plugin convention (v2 / subprocess-safe):
  //   register() returns the ILlmProviderPlugin object.
  //
  // Fallback — direct .plugin export:
  //   module.exports.plugin = { providerId, profiles, chat, stream }
  //
  // The old convention of register() having only side-effects (calling the
  // server's registerLlmPlugin) is NOT supported in subprocess mode because
  // the plugin-loader registry is bundled into plugin.cjs and is not the
  // same instance as the server's registry.
  const registerFn = mod.register ?? mod.default?.register
  if (typeof registerFn === 'function') {
    const result = registerFn()
    if (result && typeof result.chat === 'function') {
      plugin = result
    }
  }

  if (!plugin && mod.plugin && typeof mod.plugin.chat === 'function') {
    plugin = mod.plugin
  }

  if (!plugin || typeof plugin.chat !== 'function' || typeof plugin.stream !== 'function') {
    process.stderr.write(
      `${tag} FATAL: plugin.cjs must export register() => ILlmProviderPlugin ` +
      `or export .plugin — implementors should return the plugin object from register().\n`,
    )
    process.exit(2)
  }

  process.stderr.write(`${tag} Loaded: ${plugin.profiles?.length ?? 0} profile(s)\n`)
} catch (/** @type {any} */ err) {
  process.stderr.write(`${tag} FATAL: Failed to load bundle: ${err?.message ?? String(err)}\n`)
  process.exit(3)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** @param {object} obj */
function sendLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// ── Signal ready ──────────────────────────────────────────────────────────────

sendLine({ type: 'ready' })

// ── Request state ─────────────────────────────────────────────────────────────

/** @type {Set<string>} */
const cancelledIds = new Set()

/** @type {Map<string, AbortController>} */
const streamAborts = new Map()

// ── stdin / readline ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (/** @type {string} */ line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  /** @type {any} */
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }

  const { type, id } = msg

  if (type === 'ping') {
    sendLine({ type: 'pong', id })
    return
  }

  if (type === 'get_profiles') {
    const profiles = (plugin.profiles ?? []).map((/** @type {any} */ p) => ({
      ...p,
      // Ensure Prisma Decimal fields serialise as plain numbers
      cost_per_1m_input_tokens:  Number(p.cost_per_1m_input_tokens  ?? 0),
      cost_per_1m_output_tokens: Number(p.cost_per_1m_output_tokens ?? 0),
    }))
    sendLine({ type: 'profiles', id, profiles })
    return
  }

  if (type === 'cancel') {
    cancelledIds.add(id)
    const ctrl = streamAborts.get(id)
    if (ctrl) ctrl.abort()
    return
  }

  if (type === 'chat' || type === 'stream') {
    _handleRequest(type, id, msg).catch((/** @type {any} */ err) => {
      sendLine({ type: 'error', id, message: String(err?.message ?? err) })
    })
    return
  }
})

rl.on('close', () => {
  process.exit(0)
})

// ── Request handler ───────────────────────────────────────────────────────────

/**
 * @param {'chat'|'stream'} type
 * @param {string}          id
 * @param {any}             msg
 */
async function _handleRequest(type, id, msg) {
  const { profile: rawProfile, messages, options: rawOptions = {} } = msg
  const { timeout_ms } = rawOptions

  // Inject the pre-resolved API key so plugin code reading process.env works correctly.
  // The parent decrypts api_key_enc and forwards the plaintext via profile.api_key_resolved;
  // api_key_env paths are available in the subprocess env (forwarded by the bridge).
  const { api_key_resolved, ...profile } = rawProfile
  if (api_key_resolved && profile.api_key_env) {
    process.env[profile.api_key_env] = api_key_resolved
  } else if (api_key_resolved) {
    // Fallback: no api_key_env defined on profile — use a generic env var name.
    // Plugin code would need to read PLUGIN_API_KEY explicitly in this case.
    process.env['PLUGIN_API_KEY'] = api_key_resolved
  }

  // Rebuild safe options (signal + toolExecutor are not serializable and not forwarded)
  const { timeout_ms: _t, api_key_resolved: _k, signal: _s, toolExecutor: _te, ...opts } = rawOptions

  const controller = new AbortController()
  if (type === 'stream') streamAborts.set(id, controller)

  /** @type {any} */
  let timeoutHandle = null
  if (timeout_ms && timeout_ms > 0) {
    timeoutHandle = setTimeout(() => controller.abort(), timeout_ms)
  }

  const callOpts = { ...opts, signal: controller.signal }

  try {
    if (cancelledIds.has(id)) {
      cancelledIds.delete(id)
      sendLine({ type: 'error', id, message: 'Cancelled before dispatch' })
      return
    }

    if (type === 'chat') {
      const result = await plugin.chat(profile, messages, callOpts)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id)
        sendLine({ type: 'error', id, message: 'Cancelled' })
        return
      }
      sendLine({ type: 'result', id, ...result })

    } else {
      // stream
      const result = await plugin.stream(profile, messages, callOpts, (/** @type {string} */ chunk) => {
        if (!cancelledIds.has(id)) {
          sendLine({ type: 'chunk', id, chunk })
        }
      })
      if (timeoutHandle) clearTimeout(timeoutHandle)
      streamAborts.delete(id)
      if (cancelledIds.has(id)) {
        cancelledIds.delete(id)
        sendLine({ type: 'error', id, message: 'Cancelled' })
        return
      }
      sendLine({ type: 'result', id, ...result })
    }
  } catch (/** @type {any} */ err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    streamAborts.delete(id)
    if (cancelledIds.has(id)) cancelledIds.delete(id)
    const isAbort = err?.name === 'AbortError' || err?.name === 'DOMException'
    sendLine({
      type:    'error',
      id,
      message: isAbort ? 'Cancelled or timed out' : String(err?.message ?? err),
    })
  }
}
