// lib/marketplace/install-llm-plugin.ts
// Installs a Harmoven LLM provider plugin from a .hpkg archive.
//
// This is a SEPARATE install path from the standard marketplace .hpkg upload.
// The main marketplace upload (upload-hpkg.ts) intentionally blocks executable
// files (.js, .cjs, etc.) for content packs and MCP skills. LLM provider plugins
// are different: they ship pre-compiled CJS bundles executed in isolated subprocesses.
// They require explicit instance_admin installation.
//
// ── Plugin .hpkg format ───────────────────────────────────────────────────────
//   manifest.json           ← HpkgManifest with capability_type: "llm_provider_plugin"
//   harmoven-plugin.json    ← LLM plugin manifest (provider metadata)
//   plugin.cjs              ← Pre-compiled CommonJS bundle
//
// ── Security model ────────────────────────────────────────────────────────────
// - Only instance_admin can install (enforced at API layer)
// - SHA-256 of plugin.cjs verified against manifest before extraction
// - Extracted path strictly confined to lib/llm/plugins/<pack_id>/
// - pack_id must match /^[a-z0-9_-]{1,64}$/ (no traversal possible)
// - Content of harmoven-plugin.json scanned for prompt injection markers
// - Plugin runs in an isolated child process (PluginSubprocessBridge) with
//   a filtered env that excludes ENCRYPTION_KEY, AUTH_SECRET, DATABASE_URL, etc.

import { createHash } from 'node:crypto'
import fs             from 'node:fs'
import path           from 'node:path'
import JSZip          from 'jszip'
import { z }          from 'zod'
import { runPromptInjectionScan } from './static-safety-scan'

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BUNDLE_SIZE = 5_000_000   // 5 MB — compiled CJS bundle
const ZIP_MAGIC       = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const PLUGINS_DIR     = path.resolve(process.cwd(), 'lib', 'llm', 'plugins')

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Top-level manifest.json inside the .hpkg archive.
 * capability_type MUST be 'llm_provider_plugin' to be processed here.
 */
const HpkgManifestSchema = z.object({
  schema_version:  z.string(),
  capability_type: z.literal('llm_provider_plugin'),
  pack_id:         z.string().regex(/^[a-z0-9_-]{1,64}$/),
  name:            z.string().min(1).max(128),
  version:         z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  author:          z.string().max(256).optional(),
  description:     z.string().max(512).optional(),
  tags:            z.array(z.string().max(64)).max(20).optional(),
  content_sha256:  z.string().regex(/^[0-9a-f]{64}$/i),
})

/**
 * harmoven-plugin.json — LLM provider runtime manifest.
 * Also present inside the .hpkg, extracted alongside plugin.cjs.
 */
const PluginManifestSchema = z.object({
  schema_version: z.string(),
  provider_type:  z.literal('llm_provider'),
  provider_id:    z.string().regex(/^[a-z0-9_-]{1,64}$/),
  pack_id:        z.string().regex(/^[a-z0-9_-]{1,64}$/),
  name:           z.string().min(1).max(128),
  version:        z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  author:         z.string().max(256).optional(),
  description:    z.string().max(512).optional(),
  tags:           z.array(z.string().max(64)).max(20).optional(),
  warning:        z.string().max(512).optional(),
  harmoven_min_version: z.string().optional(),
  license:        z.string().optional(),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/i),
})

export type InstalledLlmPlugin = z.infer<typeof PluginManifestSchema>

// ─── Error ────────────────────────────────────────────────────────────────────

export class LlmPluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LlmPluginError'
  }
}

// ─── Installer ────────────────────────────────────────────────────────────────

export interface InstallResult {
  pack_id:     string
  provider_id: string
  name:        string
  version:     string
  hot_loaded:  boolean   // true if plugin was registered in the current process
}

/**
 * Install an LLM provider plugin from a .hpkg buffer.
 * Validates the archive, verifies SHA-256, extracts to lib/llm/plugins/<pack_id>/,
 * and hot-registers the plugin in the current server process.
 *
 * Throws LlmPluginError on any validation failure.
 */
export async function installLlmPlugin(buffer: Buffer): Promise<InstallResult> {
  // 1. Magic bytes — must be a valid ZIP
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw new LlmPluginError('INVALID_FORMAT', 'File is not a valid ZIP archive')
  }

  // 2. Unzip
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch (err) {
    throw new LlmPluginError('INVALID_FORMAT', `ZIP extraction failed: ${String(err).slice(0, 100)}`)
  }

  // 3. Parse top-level manifest.json
  const manifestEntry = zip.files['manifest.json']
  if (!manifestEntry) {
    throw new LlmPluginError('MISSING_MANIFEST', 'No manifest.json found in archive')
  }
  const manifestParsed = HpkgManifestSchema.safeParse(
    JSON.parse(await manifestEntry.async('text').catch(() => '{}')),
  )
  if (!manifestParsed.success) {
    throw new LlmPluginError(
      'INVALID_MANIFEST',
      `manifest.json validation failed: ${manifestParsed.error.message.slice(0, 200)}`,
    )
  }
  const hpkg = manifestParsed.data

  // 4. Parse harmoven-plugin.json (LLM runtime manifest)
  const pluginManifestEntry = zip.files['harmoven-plugin.json']
  if (!pluginManifestEntry) {
    throw new LlmPluginError('MISSING_PLUGIN_MANIFEST', 'No harmoven-plugin.json found in archive')
  }
  const pluginManifestText = await pluginManifestEntry.async('text')
  const pluginParsed = PluginManifestSchema.safeParse(
    JSON.parse(pluginManifestText),
  )
  if (!pluginParsed.success) {
    throw new LlmPluginError(
      'INVALID_PLUGIN_MANIFEST',
      `harmoven-plugin.json validation failed: ${pluginParsed.error.message.slice(0, 200)}`,
    )
  }
  const pluginManifest = pluginParsed.data

  // 5. pack_id must match between the two manifests
  if (hpkg.pack_id !== pluginManifest.pack_id) {
    throw new LlmPluginError(
      'MANIFEST_MISMATCH',
      'pack_id in manifest.json does not match harmoven-plugin.json',
    )
  }

  // 6. Read plugin.cjs bundle
  const bundleEntry = zip.files['plugin.cjs']
  if (!bundleEntry) {
    throw new LlmPluginError('MISSING_BUNDLE', 'No plugin.cjs found in archive')
  }
  const bundleBuffer = await bundleEntry.async('nodebuffer')

  // 7. Verify SHA-256 of bundle (content_sha256 in manifest.json)
  const actualSha256 = createHash('sha256').update(bundleBuffer).digest('hex')
  if (actualSha256.toLowerCase() !== hpkg.content_sha256.toLowerCase()) {
    throw new LlmPluginError('HASH_MISMATCH', 'content_sha256 in manifest.json does not match plugin.cjs')
  }

  // 8. Size guard
  if (bundleBuffer.length > MAX_BUNDLE_SIZE) {
    throw new LlmPluginError('BUNDLE_TOO_LARGE', `plugin.cjs exceeds ${MAX_BUNDLE_SIZE} bytes limit`)
  }

  // 9. Prompt injection scan on manifest text fields
  const scanText = [
    pluginManifest.description ?? '',
    pluginManifest.name,
    ...(pluginManifest.tags ?? []),
    pluginManifest.warning ?? '',
  ].join(' ')
  const violations = runPromptInjectionScan(scanText)
  if (violations.length > 0) {
    const first = violations[0]!
    const detail = 'pattern' in first ? first.pattern : first.type
    throw new LlmPluginError(
      'SCAN_FAILED',
      `Prompt injection pattern detected in plugin manifest: ${detail}`,
    )
  }

  // 10. Compute and validate install path (path traversal safety)
  const resolvedPluginsDir = path.resolve(PLUGINS_DIR)
  const pluginDir          = path.resolve(resolvedPluginsDir, pluginManifest.pack_id)
  if (!pluginDir.startsWith(resolvedPluginsDir + path.sep)) {
    throw new LlmPluginError('PATH_TRAVERSAL', 'pack_id would escape the plugins directory')
  }

  // 11. Write files to disk
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'harmoven-plugin.json'),
    JSON.stringify(pluginManifest, null, 2),
    'utf8',
  )
  fs.writeFileSync(path.join(pluginDir, 'plugin.cjs'), bundleBuffer)

  // 12. Hot-register in the current process via subprocess bridge (best-effort).
  //     On failure, the plugin remains on disk and will load on next server restart.
  let hotLoaded = false
  try {
    const { getLlmPlugin, registerLlmPlugin } = await import('@/lib/llm/plugin-loader')

    if (!getLlmPlugin(pluginManifest.provider_id)) {
      const { PluginSubprocessBridge } = await import('@/lib/llm/plugin-subprocess-bridge')
      const bridge = new PluginSubprocessBridge(
        path.join(pluginDir, 'plugin.cjs'),
        pluginManifest.provider_id,
      )
      await bridge.verify()
      registerLlmPlugin(bridge)
      hotLoaded = true
    } else {
      // Already registered (e.g. loaded at startup then reinstalled)
      hotLoaded = true
    }
  } catch (err) {
    // Non-fatal: plugin is on disk and will load on next server restart
    console.warn('[llm-plugin] Hot-registration failed (will load on restart):', err)
  }

  return {
    pack_id:     pluginManifest.pack_id,
    provider_id: pluginManifest.provider_id,
    name:        pluginManifest.name,
    version:     pluginManifest.version,
    hot_loaded:  hotLoaded,
  }
}

/**
 * List installed LLM provider plugins by scanning lib/llm/plugins/.
 * Returns metadata from each plugin's harmoven-plugin.json.
 */
export function listInstalledLlmPlugins(): InstalledLlmPlugin[] {
  if (!fs.existsSync(PLUGINS_DIR)) return []
  const result: InstalledLlmPlugin[] = []
  try {
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter(e => e.isDirectory())
    for (const entry of entries) {
      const manifestPath = path.join(PLUGINS_DIR, entry.name, 'harmoven-plugin.json')
      if (!fs.existsSync(manifestPath)) continue
      try {
        const raw    = fs.readFileSync(manifestPath, 'utf8')
        const parsed = PluginManifestSchema.safeParse(JSON.parse(raw))
        if (parsed.success) result.push(parsed.data)
      } catch {
        // Corrupt manifest — skip
      }
    }
  } catch {
    return []
  }
  return result
}
