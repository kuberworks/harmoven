// lib/bootstrap/load-llm-plugins.ts
// Auto-discovers and registers LLM provider plugins installed under lib/llm/plugins/.
// Called from instrumentation.ts (server-side Node.js runtime only).
//
// ── Plugin format ──────────────────────────────────────────────────────────────
// Each installed plugin lives in its own subdirectory:
//
//   lib/llm/plugins/<pack_id>/
//     harmoven-plugin.json    ← manifest (must contain provider_type: "llm_provider")
//     plugin.cjs              ← pre-compiled CommonJS bundle (ships from .hpkg)
//
// ── How to install a plugin ───────────────────────────────────────────────────
//   POST /api/admin/llm-plugins/install  (instance_admin only, multipart .hpkg)
//
//   For development: compile the TS source manually and place plugin.cjs here.
//   See scripts/build-llm-plugin.sh for the build helper.
//
// ── Security notes ────────────────────────────────────────────────────────────
// - Only files within lib/llm/plugins/ are loaded (path traversal guard on pack_id)
// - Plugins run in isolated child processes via PluginSubprocessBridge — they never
//   have access to ENCRYPTION_KEY, AUTH_SECRET, DATABASE_URL or other server secrets
// - Plugins are gitignored; the official Harmoven repo never ships plugin code
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'node:fs'
import path from 'node:path'

const PLUGINS_DIR = path.resolve(process.cwd(), 'lib', 'llm', 'plugins')

interface PluginManifest {
  provider_type?: string
  pack_id?:       string
  name?:          string
  provider_id?:   string
}

/**
 * Scan lib/llm/plugins/ at startup and register each installed LLM provider plugin.
 * Individual plugin errors are caught so a broken plugin does not prevent server startup.
 * No configuration needed — discovery is fully automatic.
 */
export async function loadLlmPlugins(): Promise<void> {
  if (!fs.existsSync(PLUGINS_DIR)) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter(e => e.isDirectory())
  } catch {
    return
  }

  for (const entry of entries) {
    const pluginDir  = path.join(PLUGINS_DIR, entry.name)
    const manifestPath = path.join(pluginDir, 'harmoven-plugin.json')
    const bundlePath   = path.join(pluginDir, 'plugin.cjs')

    // Skip if no manifest
    if (!fs.existsSync(manifestPath)) continue

    // Skip if no compiled bundle (TS source only — run build-llm-plugin.sh first)
    if (!fs.existsSync(bundlePath)) {
      console.info(
        `[llm-plugin] ${entry.name}: harmoven-plugin.json found but no plugin.cjs — ` +
        `compile the plugin with scripts/build-llm-plugin.sh before starting the server.`,
      )
      continue
    }

    try {
      // Validate manifest
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest
      if (manifest.provider_type !== 'llm_provider') continue

      // Security: ensure resolved bundle path stays within PLUGINS_DIR
      const resolvedBundle = path.resolve(bundlePath)
      const resolvedDir    = path.resolve(PLUGINS_DIR)
      if (!resolvedBundle.startsWith(resolvedDir + path.sep)) {
        console.warn(`[llm-plugin] Path traversal attempt blocked for plugin "${entry.name}" — skipping`)
        continue
      }

      // Spawn an isolated subprocess for the plugin via PluginSubprocessBridge.
      // The child process receives a filtered env that excludes server secrets
      // (ENCRYPTION_KEY, AUTH_SECRET, DATABASE_URL, etc.) — see plugin-subprocess-bridge.ts.
      const { PluginSubprocessBridge } = await import('@/lib/llm/plugin-subprocess-bridge')
      const { registerLlmPlugin }      = await import('@/lib/llm/plugin-loader')

      const bridge = new PluginSubprocessBridge(
        resolvedBundle,
        manifest.provider_id ?? entry.name,
      )
      await bridge.verify()
      registerLlmPlugin(bridge)
    } catch (err) {
      console.warn(`[llm-plugin] Failed to load plugin "${entry.name}" (non-fatal):`, err)
    }
  }
}

