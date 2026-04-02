// lib/marketplace/detect-repo-type.ts
// Static type detection for repo directory listings (B.2.3).
//
// Detection is a priority-ordered rule set applied to file names only.
// No content is fetched here except package.json (for MCP detection).
//
// Priority order:
//   1. Explicit Harmoven manifests (pack.toml, skill.yaml, agent.yaml, *.hpkg)
//   2. MCP skill detection (package.json + @modelcontextprotocol/sdk)
//   3. Generic JS/TS plugin (package.json + tsconfig/ts files)
//   4. Claude Code plugin (.claude, CLAUDE.md, .claude-plugin, commands/ + discriminant)
//   5. Unrecognised / incompatible

import { fetchCappedText, fetchCappedJson, GitUrlError, sha256hex } from './resolve-github-url'
import { runDoubleScan, runDependencyScan, buildScanResult, checkYamlBomb } from './static-safety-scan'

// ─── Types ────────────────────────────────────────────────────────────────────

export type CapabilityType =
  | 'domain_pack'
  | 'mcp_skill'
  | 'harmoven_agent'
  | 'js_ts_plugin'
  | 'slash_command'
  | 'harmoven_package'
  | 'claude_plugin'
  | 'unrecognized'

export interface DetectionResult {
  detected_type: CapabilityType
  manifest_file: string | null
  /** For claude_plugin: structured conversion report */
  claude_report?: ClaudePluginReport | null
  /** Path hint for single-file imports */
  hint?: string
  scan_passed: boolean
  scan_summary: string
  /** Extension histogram — used for unrecognised check and audit log */
  extension_histogram: Record<string, number>
}

export interface ClaudeConvertedItem {
  source:          string
  capability_type: 'domain_pack' | 'slash_command'
  pack_id?:        string
  command_name?:   string
  description?:    string
  allowed_tools?:  string[]
  mcp_dependencies?: string[]
  status:          'ready' | 'unsafe'
}

export interface ClaudeSkippedItem {
  source: string
  reason: string
}

export interface ClaudePluginReport {
  detected_type:    'claude_plugin'
  plugin_metadata?: { name?: string; version?: string; author?: string }
  converted:        ClaudeConvertedItem[]
  skipped:          ClaudeSkippedItem[]
  mcp_servers_detected: Array<{ name: string; command: string; args?: string[] }>
}

// ─── Static detection ─────────────────────────────────────────────────────────

/** File names that trigger Priority 1 detection. */
const HARMOVEN_MANIFEST_MAP: Record<string, CapabilityType> = {
  'pack.toml':   'domain_pack',
  'harmoven.toml': 'domain_pack',
  'skill.yaml':  'mcp_skill',
  'skill.yml':   'mcp_skill',
  'agent.yaml':  'harmoven_agent',
  'agent.yml':   'harmoven_agent',
  'agents.yaml': 'harmoven_agent',
  'agents.yml':  'harmoven_agent',
}

/** Build extension histogram from directory entries. */
function buildExtensionHistogram(files: string[]): Record<string, number> {
  const hist: Record<string, number> = {}
  for (const f of files) {
    const ext = f.split('.').pop()?.toLowerCase() ?? ''
    hist[ext] = (hist[ext] ?? 0) + 1
  }
  return hist
}

/** Check if a repo is dominated by non-JS/TS languages (Priority 5 heuristic). */
function isNonJsTsDominated(histogram: Record<string, number>): boolean {
  const nonJsTs = ['php', 'rb', 'go', 'java', 'py', 'rs', 'cs']
  const nonJsTsCount = nonJsTs.reduce((acc, ext) => acc + (histogram[ext] ?? 0), 0)
  const jsTsCount = (histogram['ts'] ?? 0) + (histogram['js'] ?? 0)
  return nonJsTsCount > jsTsCount
}

/**
 * Detect whether `commands/` is a Claude discriminant.
 * SEC-39: commands/ alone is insufficient — requires a secondary Claude signal.
 */
function hasClaudeCommandDiscriminant(
  fileNames: string[],
  dirNames: string[],
): boolean {
  if (fileNames.includes('CLAUDE.md')) return true
  if (dirNames.includes('.claude')) return true
  if (dirNames.includes('.claude-plugin')) return true
  return false
}

interface RawEntry {
  name: string
  type: 'file' | 'dir'
  path: string
}

// ─── Main detection function (B.2.3) ─────────────────────────────────────────

export async function detectRepoType(
  entries: RawEntry[],
  owner: string,
  repo: string,
  ref: string,
  userId?: string,
): Promise<DetectionResult> {
  const fileNames = entries.filter((e) => e.type === 'file').map((e) => e.name)
  const dirNames  = entries.filter((e) => e.type === 'dir').map((e) => e.name)
  const histogram = buildExtensionHistogram(fileNames)

  // Safety: repo too large?
  if (entries.length > 500) {
    return {
      detected_type: 'unrecognized',
      manifest_file: null,
      scan_passed: false,
      scan_summary: 'REPO_TOO_LARGE',
      extension_histogram: histogram,
    }
  }

  // Priority 1 — Explicit Harmoven manifests
  for (const [filename, type] of Object.entries(HARMOVEN_MANIFEST_MAP)) {
    if (fileNames.includes(filename)) {
      // Special: *.hpkg → route to upload flow
      return {
        detected_type: type,
        manifest_file: filename,
        scan_passed: true,
        scan_summary: 'Scan passed',
        extension_histogram: histogram,
      }
    }
  }
  // *.hpkg at root
  const hpkgFile = fileNames.find((f) => f.endsWith('.hpkg'))
  if (hpkgFile) {
    return {
      detected_type: 'harmoven_package',
      manifest_file: hpkgFile,
      scan_passed: true,
      scan_summary: 'Route to upload flow',
      extension_histogram: histogram,
    }
  }

  const hasPackageJson = fileNames.includes('package.json')

  // Priority 2 — MCP skill detection
  if (hasPackageJson) {
    try {
      const pkgUrl = buildRawUrl(owner, repo, ref, 'package.json')
      const pkgText = await fetchCappedText(pkgUrl, userId)
      const pkg = JSON.parse(pkgText) as Record<string, unknown>
      const deps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) }
      const keywords = (pkg.keywords as string[] ?? [])
      const name = (pkg.name as string ?? '')

      const hasMcpSdk = Object.keys(deps).some((k) => k.includes('@modelcontextprotocol/sdk'))
      const hasMcpKeyword = keywords.some((k) => k === 'mcp' || k === 'model-context-protocol')
      const hasMcpInName = name.includes('-mcp') || name.startsWith('mcp-')

      if (hasMcpSdk || hasMcpKeyword || hasMcpInName) {
        // Safety scan on package.json
        const scanViolations = [
          ...runDoubleScan(pkgText),
          ...runDependencyScan(deps),
        ]
        const scanResult = buildScanResult(scanViolations)
        return {
          detected_type: 'mcp_skill',
          manifest_file: 'package.json',
          scan_passed: scanResult.passed,
          scan_summary: scanResult.clientSummary,
          extension_histogram: histogram,
        }
      }

      // Priority 3 — Generic JS/TS plugin
      const hasTsConfig = fileNames.includes('tsconfig.json')
      const hasTsFiles  = fileNames.some((f) => f.endsWith('.ts'))
      if (hasTsConfig || hasTsFiles) {
        const scanViolations = [
          ...runDoubleScan(pkgText),
          ...runDependencyScan(deps),
        ]
        const scanResult = buildScanResult(scanViolations)
        return {
          detected_type: 'js_ts_plugin',
          manifest_file: 'package.json',
          scan_passed: scanResult.passed,
          scan_summary: scanResult.clientSummary,
          extension_histogram: histogram,
        }
      }
    } catch {
      // If package.json fetch fails, fall through
    }
  }

  // Priority 4 — Claude Code plugin
  const hasClaudeMd      = fileNames.includes('CLAUDE.md')
  const hasClaudeDir     = dirNames.includes('.claude')
  const hasClaudePlugin  = dirNames.includes('.claude-plugin')
  const hasCommandsDir   = dirNames.includes('commands')

  const isClaudePlugin =
    hasClaudeMd ||
    hasClaudeDir ||
    hasClaudePlugin ||
    (hasCommandsDir && hasClaudeCommandDiscriminant(fileNames, dirNames))

  if (isClaudePlugin) {
    const report = await buildClaudePluginReport(
      entries, owner, repo, ref, userId,
      fileNames, dirNames, hasCommandsDir
    )
    return {
      detected_type: 'claude_plugin',
      manifest_file: null,
      claude_report: report,
      scan_passed: report.converted.every((c) => c.status === 'ready'),
      scan_summary: `Claude plugin: ${report.converted.length} convertible, ${report.skipped.length} skipped`,
      extension_histogram: histogram,
    }
  }

  // Priority 5 — Unrecognised
  if (isNonJsTsDominated(histogram)) {
    return {
      detected_type: 'unrecognized',
      manifest_file: null,
      scan_passed: false,
      scan_summary: 'UNRECOGNIZED_REPO — non-JS/TS language dominant',
      extension_histogram: histogram,
    }
  }

  return {
    detected_type: 'unrecognized',
    manifest_file: null,
    scan_passed: false,
    scan_summary: 'UNRECOGNIZED_REPO — no recognised plugin format found',
    extension_histogram: histogram,
  }
}

// ─── Claude plugin conversion (Priority 4) ───────────────────────────────────

const MAX_COMMAND_NAME_LENGTH = 64
const MAX_PROMPT_TEMPLATE_LENGTH = 32_768
const MAX_ALLOWED_TOOLS = 50
const MAX_ALLOWED_TOOL_LENGTH = 256

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/, '')
    .slice(0, MAX_COMMAND_NAME_LENGTH)
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/)
  if (!fm) return { meta: {}, body: content }
  try {
    // Simple YAML frontmatter parse (key: value pairs only — no nesting)
    const meta: Record<string, unknown> = {}
    const lines = (fm[1] ?? '').split('\n')
    for (const line of lines) {
      const m = line.match(/^(\w[\w-]*):\s*(.+)$/)
      if (m) meta[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '')
    }
    // allowed-tools: [a, b]
    const toolsLine = (fm[1] ?? '').match(/^allowed-tools:\s*\[(.*)\]/m)
    if (toolsLine) {
      meta['allowed-tools'] = toolsLine[1]!.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    }
    return { meta, body: (fm[2] ?? '').trim() }
  } catch {
    return { meta: {}, body: (fm[2] ?? content).trim() }
  }
}

function extractMcpDependencies(allowedTools: string[]): string[] {
  return allowedTools.filter((t) => t.startsWith('mcp__'))
}

async function buildClaudePluginReport(
  entries: RawEntry[],
  owner: string,
  repo: string,
  ref: string,
  userId: string | undefined,
  fileNames: string[],
  dirNames: string[],
  hasCommandsDir: boolean,
): Promise<ClaudePluginReport> {
  const converted: ClaudeConvertedItem[] = []
  const skipped: ClaudeSkippedItem[] = []
  const mcp_servers_detected: Array<{ name: string; command: string; args?: string[] }> = []

  let plugin_metadata: ClaudePluginReport['plugin_metadata'] = {}

  // .claude-plugin/plugin.json metadata
  if (dirNames.includes('.claude-plugin')) {
    try {
      const pluginJsonUrl = buildRawUrl(owner, repo, ref, '.claude-plugin/plugin.json')
      const pluginJsonText = await fetchCappedText(pluginJsonUrl, userId)
      const pluginJson = JSON.parse(pluginJsonText) as Record<string, unknown>
      plugin_metadata = {
        name:    pluginJson.name as string | undefined,
        version: pluginJson.version as string | undefined,
        author:  pluginJson.author as string | undefined,
      }
      // Scan plugin.json description + name for prompt injection
      const descScan = runDoubleScan(`${pluginJson.name ?? ''} ${pluginJson.description ?? ''}`)
      if (descScan.some((v) => v.type === 'prompt_injection')) {
        skipped.push({ source: '.claude-plugin/plugin.json', reason: 'CONTENT_SCAN_FAILED' })
      }
    } catch {
      // metadata fetch failure is non-fatal
    }
  }

  // CLAUDE.md → domain_pack
  if (fileNames.includes('CLAUDE.md')) {
    try {
      const url = buildRawUrl(owner, repo, ref, 'CLAUDE.md')
      const content = await fetchCappedText(url, userId)
      const violations = runDoubleScan(content)
      if (violations.length > 0) {
        skipped.push({ source: 'CLAUDE.md', reason: 'CONTENT_SCAN_FAILED' })
      } else {
        const packId = slugify(repo)
        converted.push({
          source: 'CLAUDE.md',
          capability_type: 'domain_pack',
          pack_id: packId,
          status: 'ready',
        })
      }
    } catch {
      skipped.push({ source: 'CLAUDE.md', reason: 'FETCH_FAILED' })
    }
  }

  // commands/*.md → slash_commands
  const commandsPaths = getCommandFilePaths(entries, hasCommandsDir)
  for (const filePath of commandsPaths) {
    try {
      const url = buildRawUrl(owner, repo, ref, filePath)
      const content = await fetchCappedText(url, userId)

      if (content.length > MAX_PROMPT_TEMPLATE_LENGTH) {
        skipped.push({ source: filePath, reason: 'CONTENT_TOO_LARGE' })
        continue
      }

      const violations = runDoubleScan(content)
      const { meta, body } = parseFrontmatter(content)

      const rawTools = (meta['allowed-tools'] as string[] | string | undefined)
      let allowedTools: string[] = []
      if (Array.isArray(rawTools)) {
        allowedTools = rawTools
      } else if (typeof rawTools === 'string') {
        allowedTools = [rawTools]
      }
      // Truncate excess entries — SEC-37
      if (allowedTools.length > MAX_ALLOWED_TOOLS) {
        allowedTools = allowedTools.slice(0, MAX_ALLOWED_TOOLS)
      }
      allowedTools = allowedTools.map((t) => t.slice(0, MAX_ALLOWED_TOOL_LENGTH))

      if (violations.length > 0 || body.length === 0) {
        const item: ClaudeConvertedItem = {
          source: filePath,
          capability_type: 'slash_command',
          command_name: slugify(filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'cmd'),
          description:  (meta.description as string | undefined)?.slice(0, 512),
          allowed_tools: allowedTools,
          mcp_dependencies: extractMcpDependencies(allowedTools),
          status: 'unsafe',
        }
        converted.push(item)
      } else {
        const commandName = slugify(filePath.split('/').pop()?.replace(/\.md$/, '') ?? 'cmd')
        converted.push({
          source:           filePath,
          capability_type:  'slash_command',
          command_name:     commandName,
          description:      (meta.description as string | undefined)?.slice(0, 512),
          allowed_tools:    allowedTools,
          mcp_dependencies: extractMcpDependencies(allowedTools),
          status: 'ready',
        })
      }
    } catch {
      skipped.push({ source: filePath, reason: 'FETCH_FAILED' })
    }
  }

  // .claude/hooks/ — always rejected
  const hookEntries = entries.filter((e) =>
    e.type === 'file' && e.path.startsWith('.claude/hooks/'),
  )
  for (const hook of hookEntries) {
    skipped.push({ source: hook.path, reason: 'SHELL_HOOK_REJECTED' })
  }

  // .claude/settings.json — extract mcpServers (never auto-imported)
  const hasClaudeSettings = entries.some((e) => e.path === '.claude/settings.json')
  if (hasClaudeSettings) {
    try {
      const url = buildRawUrl(owner, repo, ref, '.claude/settings.json')
      const text = await fetchCappedText(url, userId)
      const settings = JSON.parse(text) as Record<string, unknown>
      const mcpServers = settings.mcpServers as Record<string, { command?: string; args?: string[] }> | undefined
      if (mcpServers) {
        for (const [name, cfg] of Object.entries(mcpServers)) {
          mcp_servers_detected.push({
            name,
            command: cfg.command ?? 'npx',
            args:    cfg.args,
          })
        }
      }
    } catch {
      // non-fatal
    }
  }

  if (converted.length === 0 && skipped.length > 0) {
    // Nothing convertible
  }

  return {
    detected_type: 'claude_plugin',
    plugin_metadata: Object.keys(plugin_metadata).length > 0 ? plugin_metadata : undefined,
    converted,
    skipped,
    mcp_servers_detected,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRawUrl(owner: string, repo: string, ref: string, path: string): string {
  const r = ref || 'HEAD'
  return `https://raw.githubusercontent.com/${owner}/${repo}/${r}/${path}`
}

function getCommandFilePaths(entries: RawEntry[], hasCommandsDir: boolean): string[] {
  const paths: string[] = []
  // commands/*.md at root
  if (hasCommandsDir) {
    for (const e of entries) {
      if (e.type === 'file' && e.path.startsWith('commands/') && e.name.endsWith('.md')) {
        paths.push(e.path)
      }
    }
  }
  // .claude/commands/*.md
  for (const e of entries) {
    if (e.type === 'file' && e.path.startsWith('.claude/commands/') && e.name.endsWith('.md')) {
      paths.push(e.path)
    }
  }
  return paths
}
