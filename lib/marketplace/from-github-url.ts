// lib/marketplace/from-github-url.ts
// Convert a raw GitHub file URL into a Harmoven pack scaffold.
//
// Security controls implemented (spec v3):
//   SEC-01  Hostname whitelist — raw.githubusercontent.com | api.github.com only,
//           checked by string comparison on the *parsed* hostname, no DNS lookup.
//   SEC-02  fetch with redirect:'error' + AbortSignal.timeout(8_000) + 1 MB streaming cap.
//   SEC-03  SHA-256 stored for traceability only — no false integrity guarantee.
//   SEC-04  Double scan: raw bytes before parse + extracted fields after parse.
//   SEC-05  pack_id validated against /^[a-z0-9_]{1,64}$/ after slugification.
//   SEC-06  All errors thrown as GitHubImportError with opaque codes for the caller.
//   SEC-10  Returned preview includes content_sha256 for hash-locking at approval time.

import { createHash } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import yaml from 'js-yaml'
import { scanPackContent } from '@/lib/marketplace/scan'

// ─── Constants ────────────────────────────────────────────────────────────────

/** SEC-01: Only these hostnames may be fetched. Checked after URL.parse(), no DNS. */
const ALLOWED_HOSTS = new Set(['raw.githubusercontent.com', 'api.github.com'])

const MAX_BYTES = 1_000_000 // 1 MB — mirrors PackManifestSchema.content max

/** Regexp for valid pack IDs: lowercase alphanumeric + underscores, 1–64 chars. */
const PACK_ID_RE = /^[a-z0-9_]{1,64}$/

// ─── Error type ───────────────────────────────────────────────────────────────

/** Opaque error codes sent to the client (SEC-06). Technical details go to AuditLog. */
export type GitHubImportErrorCode =
  | 'FORBIDDEN_HOST'
  | 'CONTENT_TOO_LARGE'
  | 'FETCH_FAILED'
  | 'PARSE_FAILED'
  | 'SCAN_FAILED'
  | 'INVALID_PACK_ID'
  | 'RATE_LIMITED'

export class GitHubImportError extends Error {
  constructor(
    /** Opaque code safe to return to the client. */
    readonly code: GitHubImportErrorCode,
    /** Technical detail — log server-side only, never send to client. */
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'GitHubImportError'
  }
}

// ─── Result types ─────────────────────────────────────────────────────────────

/** A single scaffolded field with an inferred flag (SEC-09). */
export interface ScaffoldedField<T = string> {
  value:    T
  /** true = field was not found in source, derived automatically. */
  inferred: boolean
}

/** Full preview scaffold returned to the admin before approval. */
export interface GitHubImportPreview {
  /** The canonicalized URL that was fetched. */
  source_url:     string
  /** SHA-256 of raw content — for hash-locking at approval (SEC-10). */
  content_sha256: string
  /** Raw bytes count. */
  content_size:   number

  // Scaffolded fields
  pack_id:        ScaffoldedField
  name:           ScaffoldedField
  version:        ScaffoldedField
  author:         ScaffoldedField
  description:    ScaffoldedField
  system_prompt:  ScaffoldedField
  tags:           ScaffoldedField<string[]>
  /** Detected capability type. */
  capability_type: ScaffoldedField<'domain_pack' | 'mcp_skill' | 'prompt_only'>
  /** MCP command if capability_type = mcp_skill. */
  mcp_command:    ScaffoldedField | null

  /** Short sha7 of the commit at import time — for display and source_ref storage. */
  commit_sha?: string

  /** Full scan violations — always empty on success (scan passed to get here). */
  scan_violations: string[]
  /**
   * External URL references found in the pack that were fetched and scanned clean.
   * Present only when the pack references allowed external URLs (e.g. a guidelines file).
   * Admin must confirm these before approval.
   */
  scan_warnings: ExternalUrlWarning[]
  /** True if any field is inferred (triggers mandatory review badge in UI). */
  has_inferred_fields: boolean
}

export interface ExternalUrlWarning {
  /** The external URL referenced by the pack. */
  url:        string
  /** SHA-256 of the content at that URL at import time. */
  sha256:     string
  /** Byte size of the fetched content. */
  size:       number
}

// ─── SEC-01: Host validation ──────────────────────────────────────────────────

function assertAllowedHost(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new GitHubImportError('FORBIDDEN_HOST', `Invalid URL: ${rawUrl.slice(0, 200)}`)
  }

  // Block non-https protocols
  if (parsed.protocol !== 'https:') {
    throw new GitHubImportError(
      'FORBIDDEN_HOST',
      `Protocol "${parsed.protocol}" blocked — only https allowed`,
    )
  }

  // Block credentials
  if (parsed.username || parsed.password) {
    throw new GitHubImportError('FORBIDDEN_HOST', 'Credentials in URL are not allowed')
  }

  // Whitelist check — string comparison on hostname, no DNS (SEC-01)
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new GitHubImportError(
      'FORBIDDEN_HOST',
      `Host "${parsed.hostname}" not in whitelist [${[...ALLOWED_HOSTS].join(', ')}]`,
    )
  }

  return parsed
}

// ─── SEC-02: Fetch with redirect:error + streaming cap ───────────────────────

async function fetchCapped(url: URL): Promise<string> {
  let res: Response
  try {
    res = await fetch(url.toString(), {
      redirect: 'error',                   // SEC-02: no redirect following
      signal:   AbortSignal.timeout(8_000), // SEC-02: 8 s timeout
      headers:  { 'User-Agent': 'Harmoven/1.0 (+https://harmoven.com)' },
    })
  } catch (e) {
    throw new GitHubImportError('FETCH_FAILED', `fetch error: ${String(e).slice(0, 200)}`)
  }

  if (!res.ok) {
    throw new GitHubImportError('FETCH_FAILED', `HTTP ${res.status} from ${url.hostname}`)
  }

  // SEC-02: Streaming read with byte cap — prevents OOM from a huge file
  if (!res.body) {
    throw new GitHubImportError('FETCH_FAILED', 'Response body is null')
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_BYTES) {
        throw new GitHubImportError(
          'CONTENT_TOO_LARGE',
          `Response exceeds ${MAX_BYTES} byte cap`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  // Decode as UTF-8
  const combined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(combined)
}

// ─── Markdown name/description extractor ────────────────────────────────────

/**
 * Parse a Markdown file that may start with a YAML frontmatter block (--- … ---).
 * Extracts: display_name, description, author, version, tags from frontmatter if present.
 * Falls back to heading extraction when no frontmatter is found.
 * Full raw content (including frontmatter) is kept as system_prompt.
 */
function parseMarkdownPack(raw: string): ParsedPack {
  // ── Frontmatter extraction ────────────────────────────────────────────────
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fmMatch) {
    const fmRaw = fmMatch[1]
    // Simple key: value parser — no full YAML, untrusted input
    const get = (key: string): string | undefined => {
      const m = fmRaw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
      return m ? m[1].trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '') : undefined
    }
    const name        = get('name') ?? get('display_name')
    const description = get('description')
    const author      = get('author')
    const version     = get('version')
    const tagsRaw     = get('tags')
    const tags        = tagsRaw
      ? tagsRaw.replace(/[\[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean)
      : undefined
    // Only trust frontmatter if it provides at least a name or description
    if (name ?? description) {
      return { display_name: name, description, author, version, tags, system_prompt: raw }
    }
  }

  // ── Heading + first-paragraph extraction (no usable frontmatter) ─────────
  const lines = raw.split(/\r?\n/)
  let name: string | undefined
  let description: string | undefined

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,2}\s+(.+)$/)
    if (headingMatch && !name) {
      name = headingMatch[1]
        .replace(/\*{1,2}|_{1,2}|`/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim()
        .slice(0, 80)
      continue
    }
    if (!description && name) {
      const trimmed = line.trim()
      if (
        trimmed &&
        !trimmed.startsWith('```') &&
        !trimmed.startsWith('---') &&
        !trimmed.startsWith('![') &&
        !trimmed.startsWith('<') &&
        !trimmed.startsWith('|')
      ) {
        description = trimmed
          .replace(/\*{1,2}|_{1,2}|`/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .slice(0, 200)
        break
      }
    }
  }

  return { display_name: name, description, system_prompt: raw }
}

// ─── SEC-05: pack_id slugification ───────────────────────────────────────────

function toPackId(repoName: string): string {
  const slug = repoName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') // trim leading/trailing underscores
    .slice(0, 64)

  if (!PACK_ID_RE.test(slug)) {
    throw new GitHubImportError(
      'INVALID_PACK_ID',
      `Slugified pack_id "${slug}" does not match ${PACK_ID_RE.source}`,
    )
  }
  return slug
}

// ─── Format detection + parsing ───────────────────────────────────────────────

type ParsedPack = {
  id?:           string
  display_name?: string
  name?:         string
  version?:      string
  author?:       string
  description?:  string
  tags?:         string[]
  system_prompt?: string
  /** MCP: if detected */
  mcp_command?:  string
  /** Package.json: if detected */
  bin?:          Record<string, string>
  main?:         string
}

function parseContent(raw: string, filename: string): ParsedPack {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''

  // TOML
  if (ext === 'toml' || ext === 'pack') {
    try {
      return parseToml(raw) as ParsedPack
    } catch (e) {
      throw new GitHubImportError('PARSE_FAILED', `TOML parse error: ${String(e).slice(0, 200)}`)
    }
  }

  // YAML / YML
  if (ext === 'yaml' || ext === 'yml') {
    try {
      // yaml.JSON_SCHEMA restricts to JSON-compatible types only — prevents
      // !!timestamp → Date and !!binary → Buffer coercions on untrusted content.
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
      if (typeof parsed !== 'object' || parsed === null) {
        throw new GitHubImportError('PARSE_FAILED', 'YAML root must be a mapping')
      }
      return parsed as ParsedPack
    } catch (e) {
      if (e instanceof GitHubImportError) throw e
      throw new GitHubImportError('PARSE_FAILED', `YAML parse error: ${String(e).slice(0, 200)}`)
    }
  }

  // JSON / package.json
  if (ext === 'json') {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) {
        throw new GitHubImportError('PARSE_FAILED', 'JSON root must be an object')
      }
      return parsed as ParsedPack
    } catch (e) {
      if (e instanceof GitHubImportError) throw e
      throw new GitHubImportError('PARSE_FAILED', `JSON parse error: ${String(e).slice(0, 200)}`)
    }
  }

  // Markdown / plain text → extract name + description from headings, rest = system_prompt
  if (ext === 'md' || ext === 'txt' || ext === '') {
    return parseMarkdownPack(raw)
  }

  throw new GitHubImportError('PARSE_FAILED', `Unrecognised file extension ".${ext}"`)
}

// ─── Capability detection ─────────────────────────────────────────────────────

const MCP_ALLOWED_COMMANDS = new Set(['npx', 'node', 'nodejs', 'python', 'python3', 'uvx', 'uv', 'deno', 'bun'])

function detectCapability(parsed: ParsedPack): {
  type:       'domain_pack' | 'mcp_skill' | 'prompt_only'
  mcp_command: string | null
} {
  // MCP skill: has a bin or main entry + typical mcp patterns
  const hasBin  = parsed.bin && Object.keys(parsed.bin).length > 0
  const hasMain = !!parsed.main
  if ((hasBin || hasMain) && !parsed.system_prompt) {
    const cmd = parsed.mcp_command ?? 'npx'
    const cmdBase = cmd.split('/').pop() ?? cmd
    const safeCmdBase = MCP_ALLOWED_COMMANDS.has(cmdBase) ? cmdBase : 'npx'
    return { type: 'mcp_skill', mcp_command: safeCmdBase }
  }

  // Domain pack: has system_prompt (id may be inferred from URL — still a real pack)
  if (parsed.system_prompt) {
    return { type: 'domain_pack', mcp_command: null }
  }

  // Fallback: prompt-only
  return { type: 'prompt_only', mcp_command: null }
}

// ─── Infer pack_id from URL path ──────────────────────────────────────────────

function inferPackIdFromUrl(parsedUrl: URL): string {
  // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path…/file>
  // api.github.com/repos/<owner>/<repo>/contents/<path…/file>
  const segments = parsedUrl.pathname.split('/').filter(Boolean)

  let pathSegments: string[]
  let repoName: string
  if (parsedUrl.hostname === 'api.github.com') {
    // /repos/<owner>/<repo>/contents/<path…>
    repoName     = segments[2] ?? 'unknown'
    pathSegments = segments.slice(4) // after 'contents'
  } else {
    // /<owner>/<repo>/<ref>/<path…>
    repoName     = segments[1] ?? 'unknown'
    pathSegments = segments.slice(3) // after ref
  }

  // Prefer the parent directory of the file when the file is in a subdirectory,
  // e.g. skills/frontend-design/SKILL.md → 'frontend-design' is more specific than 'skills'
  const parentDir = pathSegments.length >= 2
    ? pathSegments[pathSegments.length - 2]
    : undefined

  return toPackId(parentDir ?? repoName)
}

// ─── External URL reference scanner ──────────────────────────────────────────

const MAX_EXTERNAL_URL_REFS = 3    // hard cap on how many external URLs we follow per pack
const HTTPS_URL_RE = /https?:\/\/[^\s"'`)\]>]+/gi

/**
 * Extract all https URLs from raw pack content.
 * Capped at MAX_EXTERNAL_URL_REFS to avoid runaway fetching.
 */
function extractHttpsUrls(content: string): string[] {
  const matches = [...content.matchAll(HTTPS_URL_RE)]
    .map((m) => m[0].replace(/[.,;:!?]+$/, '')) // strip trailing punctuation
  return [...new Set(matches)].slice(0, MAX_EXTERNAL_URL_REFS)
}

/**
 * For each external URL in the pack content that passes the host whitelist:
 *   1. Fetch it through our security pipeline (redirect:error, 8s, 1MB cap)
 *   2. Scan the fetched content for injection patterns AND further external URLs
 *   3. If the fetched content is clean → produce a warning (not an error)
 *   4. If the fetched content has injection OR its own external URLs → hard fail
 *
 * Returns { warnings, hardFailReason }:
 *   - warnings: URLs that were fetched and scanned clean (admin must confirm)
 *   - hardFailReason: non-null string if any fetched content failed secondary scan
 */
async function scanExternalUrlRefs(content: string): Promise<{
  warnings:       ExternalUrlWarning[]
  hardFailReason: string | null
}> {
  const urls = extractHttpsUrls(content)
  const warnings: ExternalUrlWarning[] = []

  for (const rawUrl of urls) {
    // Only follow URLs on allowed hosts — skip others silently
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      continue
    }
    if (!ALLOWED_HOSTS.has(parsed.hostname)) continue

    // Fetch through the same security controls as the main pack file
    let fetched: string
    try {
      fetched = await fetchCapped(parsed)
    } catch {
      // Unreachable URL at import time → hard fail (can't guarantee safety at runtime)
      return {
        warnings:       [],
        hardFailReason: `External URL referenced by pack is unreachable at import time: ${rawUrl.slice(0, 100)}`,
      }
    }

    // Hash for traceability
    const sha256 = createHash('sha256').update(fetched).digest('hex')

    // Secondary scan: injection patterns → hard fail; external URLs → hard fail (no second level)
    const secondaryScan = scanPackContent(fetched)
    if (secondaryScan.hasInjection) {
      return {
        warnings:       [],
        hardFailReason: `External URL content failed injection scan: ${rawUrl.slice(0, 100)}`,
      }
    }
    if (secondaryScan.hasExternalUrl) {
      return {
        warnings:       [],
        hardFailReason: `External URL content itself references further external URLs (max 1 level): ${rawUrl.slice(0, 100)}`,
      }
    }

    warnings.push({ url: rawUrl, sha256, size: Buffer.byteLength(fetched) })
  }

  return { warnings, hardFailReason: null }
}

// ─── SEC-04: Double scan ───────────────────────────────────────────────────────

function runDoubleScan(rawContent: string, parsed: ParsedPack, filename: string): string[] {
  const violations: string[] = []
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(filename)

  // Pass 1: raw bytes before any interpretation.
  // For Markdown files, skip the external_url check — documentation legitimately
  // contains external links (badges, screenshots, install links). The injection
  // patterns still apply.
  const rawScan = scanPackContent(rawContent)
  const rawViolations = isMarkdown
    ? rawScan.violations.filter((v) => v.type !== 'external_url')
    : rawScan.violations
  if (rawViolations.length > 0) {
    violations.push(...rawViolations.map((v) => `[raw] ${v.reason}`))
  }

  // Pass 2: extracted system_prompt field
  if (parsed.system_prompt) {
    const promptScan = scanPackContent(parsed.system_prompt)
    if (!promptScan.passed) {
      violations.push(...promptScan.violations.map((v) => `[system_prompt] ${v.reason}`))
    }
  }

  // Pass 3: extracted description field
  if (parsed.description) {
    const descScan = scanPackContent(parsed.description)
    if (!descScan.passed) {
      violations.push(...descScan.violations.map((v) => `[description] ${v.reason}`))
    }
  }

  return violations
}

// ─── GitHub URL normalizer ────────────────────────────────────────────────────

/** Pack file extensions in preference order when scanning a GitHub directory. */
const PACK_EXTENSIONS = ['.toml', '.pack', '.yaml', '.yml', '.json', '.md']

/**
 * Normalise any public GitHub URL to one that `previewFromGitHubUrl` can fetch.
 *
 * Handled patterns:
 *   github.com/{owner}/{repo}/blob/{ref}/{path}  → raw.githubusercontent.com URL
 *   github.com/{owner}/{repo}/tree/{ref}/{dir}   → best pack file in that directory
 *                                                    (resolved via GitHub Contents API)
 *   raw.githubusercontent.com/…  }
 *   api.github.com/…             }  → returned unchanged (validated later by assertAllowedHost)
 *
 * Throws GitHubImportError on any unrecognised github.com pattern or API failure.
 */
export async function normalizeGitHubUrl(rawUrl: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new GitHubImportError('FORBIDDEN_HOST', `Invalid URL: ${rawUrl.slice(0, 200)}`)
  }

  // Already a raw/API URL — let assertAllowedHost inside previewFromGitHubUrl validate it
  if (parsed.hostname !== 'github.com') {
    return rawUrl
  }

  // github.com/{owner}/{repo}/blob/{ref}/{path…}
  const blobMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
  if (blobMatch) {
    const [, owner, repo, ref, filePath] = blobMatch
    // Encode each segment individually — filePath may contain slashes (preserved) but
    // other special chars must be encoded to prevent URL injection.
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}`
  }

  // github.com/{owner}/{repo}/tree/{ref}/{dir…}
  const treeMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/)
  if (treeMatch) {
    const [, owner, repo, ref, dirPath] = treeMatch
    // Encode owner/repo individually; dirPath preserves slashes but encodes other special chars.
    const encodedDir = dirPath.split('/').map(encodeURIComponent).join('/')
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedDir}?ref=${encodeURIComponent(ref)}`

    let res: Response
    try {
      res = await fetch(apiUrl, {
        redirect: 'error',
        signal:   AbortSignal.timeout(8_000),
        headers:  {
          'User-Agent': 'Harmoven/1.0 (+https://harmoven.com)',
          'Accept':     'application/vnd.github.v3+json',
        },
      })
    } catch (e) {
      throw new GitHubImportError('FETCH_FAILED', `GitHub API fetch error: ${String(e).slice(0, 200)}`)
    }

    if (!res.ok) {
      throw new GitHubImportError('FETCH_FAILED', `GitHub API HTTP ${res.status} for directory listing`)
    }

    // Cap API response at 512 KB to prevent OOM on unexpectedly large listings
    const reader = res.body?.getReader()
    if (!reader) throw new GitHubImportError('FETCH_FAILED', 'GitHub API response body is null')

    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > 512_000) {
          throw new GitHubImportError('CONTENT_TOO_LARGE', 'GitHub directory listing exceeds 512 KB cap')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }

    const combined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength }
    const rawJson = new TextDecoder('utf-8', { fatal: false }).decode(combined)

    let entries: unknown
    try { entries = JSON.parse(rawJson) } catch {
      throw new GitHubImportError('PARSE_FAILED', 'GitHub API returned non-JSON directory listing')
    }

    if (!Array.isArray(entries)) {
      throw new GitHubImportError('PARSE_FAILED', 'Expected GitHub API to return an array for directory contents')
    }

    // Pick the best pack file by extension priority
    for (const ext of PACK_EXTENSIONS) {
      const entry = (entries as Array<Record<string, unknown>>).find(
        (e) => e.type === 'file' && typeof e.name === 'string' && e.name.endsWith(ext) && typeof e.download_url === 'string',
      )
      if (entry) {
        const dlUrl = entry.download_url as string
        // Verify the download_url is a raw.githubusercontent.com URL before returning —
        // defence-in-depth against a tampered/unexpected API response.
        // assertAllowedHost inside previewFromGitHubUrl will do a full validation too.
        if (!dlUrl.startsWith('https://raw.githubusercontent.com/')) {
          throw new GitHubImportError(
            'FORBIDDEN_HOST',
            `Unexpected download_url host in GitHub API response: ${dlUrl.slice(0, 100)}`,
          )
        }
        return dlUrl
      }
    }

    throw new GitHubImportError(
      'PARSE_FAILED',
      `No recognisable pack file found in directory "${dirPath}" (looked for: ${PACK_EXTENSIONS.join(', ')})`,
    )
  }

  throw new GitHubImportError(
    'FORBIDDEN_HOST',
    `Unrecognised github.com URL pattern: ${parsed.pathname.slice(0, 200)}`,
  )
}

// ─── GitHub repo metadata (owner, version) ───────────────────────────────────

interface GitHubMeta { owner: string; version: string; commit_sha: string }

/**
 * Resolve owner + a meaningful version string from a raw.githubusercontent.com URL.
 *
 * version  = the ref itself (branch name or tag name, e.g. "main", "v1.2.3")
 * commit_sha = short sha7 of the commit at that ref (empty string if unresolvable)
 *
 * Non-fatal: on any API/network error returns owner from URL + version=ref, commit_sha=''.
 */
async function resolveGitHubMeta(parsedUrl: URL): Promise<GitHubMeta> {
  // Works on raw.githubusercontent.com/<owner>/<repo>/<ref>/...
  const segments = parsedUrl.pathname.split('/').filter(Boolean)
  const owner = segments[0] ?? ''
  const repo  = segments[1] ?? ''
  const ref   = segments[2] ?? ''   // branch name OR commit SHA OR tag name

  if (!owner || !repo) return { owner, version: ref || '', commit_sha: '' }

  const defaultMeta: GitHubMeta = { owner, version: ref || '', commit_sha: '' }

  try {
    // 1. Try latest tag
    const tagsRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?per_page=10`,
      {
        redirect: 'error',
        signal:   AbortSignal.timeout(5_000),
        headers:  {
          'User-Agent': 'Harmoven/1.0 (+https://harmoven.com)',
          'Accept':     'application/vnd.github.v3+json',
        },
      },
    )
    if (tagsRes.ok) {
      const tags = await tagsRes.json() as Array<{ name: string }>
      // Pick first semver-ish tag — use it as-is as the version string
      const semverTag = tags.find((t) => /^v?\d+\.\d+/.test(t.name))
      if (semverTag) {
        // Still resolve commit sha for traceability
        return { owner, version: semverTag.name, commit_sha: '' }
      }
    }

    // 2. If ref looks like a branch (not a 40-char hex SHA), resolve to commit SHA
    const isSha = /^[0-9a-f]{40}$/i.test(ref)
    if (!isSha && ref) {
      const commitRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
        {
          redirect: 'error',
          signal:   AbortSignal.timeout(5_000),
          headers:  {
            'User-Agent': 'Harmoven/1.0 (+https://harmoven.com)',
            'Accept':     'application/vnd.github.v3+json',
          },
        },
      )
      if (commitRes.ok) {
        // Size-cap the commit response — it can include patch diffs (potentially large).
        const MAX_COMMIT_BYTES = 64_000
        const commitReader = commitRes.body?.getReader()
        if (commitReader) {
          const commitChunks: Uint8Array[] = []
          let commitTotal = 0
          try {
            while (true) {
              const { done, value } = await commitReader.read()
              if (done) break
              commitTotal += value.byteLength
              if (commitTotal > MAX_COMMIT_BYTES) break // truncate — we only need the sha
              commitChunks.push(value)
            }
          } finally { commitReader.releaseLock() }
          const commitCombined = new Uint8Array(commitTotal > MAX_COMMIT_BYTES ? MAX_COMMIT_BYTES : commitTotal)
          let off = 0
          for (const c of commitChunks) { commitCombined.set(c.slice(0, MAX_COMMIT_BYTES - off), off); off += c.byteLength; if (off >= MAX_COMMIT_BYTES) break }
          const commitText = new TextDecoder('utf-8', { fatal: false }).decode(commitCombined)
          // Best-effort JSON parse of truncated buffer — we only care about .sha at the top level
          const shaMatch = commitText.match(/"sha"\s*:\s*"([0-9a-f]{40})"/)
          if (shaMatch) return { owner, version: ref, commit_sha: shaMatch[1].slice(0, 7) }
        }
      }
    }
  } catch {
    // Non-fatal — fall through
  }

  return defaultMeta
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch a GitHub raw file URL and scaffold a Harmoven pack preview.
 *
 * Throws GitHubImportError with opaque codes on all failure modes.
 * The caller is responsible for:
 *   - Rate limiting BEFORE calling this (SEC-07)
 *   - Storing the returned content_sha256 for approval hash-locking (SEC-10)
 *   - Logging technical error details to AuditLog on catch (SEC-11)
 */
export async function previewFromGitHubUrl(rawUrl: string): Promise<GitHubImportPreview> {
  // SEC-01: Whitelist check — throws FORBIDDEN_HOST if not allowed
  const parsedUrl = assertAllowedHost(rawUrl)

  // SEC-02: Fetch with redirect:error, 8 s timeout, 1 MB streaming cap
  const rawContent = await fetchCapped(parsedUrl)

  // SEC-03: Hash for traceability + hash-locking at approval (SEC-10)
  const content_sha256 = createHash('sha256').update(rawContent).digest('hex')

  // Parse — throws PARSE_FAILED on error
  const filename = parsedUrl.pathname.split('/').pop() ?? ''
  const parsed   = parseContent(rawContent, filename)

  // SEC-04: Double scan — raw + extracted fields
  const scanViolations = runDoubleScan(rawContent, parsed, filename)

  // Split hard violations (injection) from soft ones (external URLs).
  // External URLs get a secondary fetch+scan instead of an immediate hard fail.
  const hardViolations = scanViolations.filter((v) => v.type === 'injection')
  const urlViolations  = scanViolations.filter((v) => v.type === 'external_url')

  if (hardViolations.length > 0) {
    throw new GitHubImportError(
      'SCAN_FAILED',
      `Security scan found ${hardViolations.length} injection violation(s): ${hardViolations.map((v) => v.reason).join('; ')}`,
    )
  }

  // For external URL references: fetch and scan each one (single level)
  let scanWarnings: ExternalUrlWarning[] = []
  if (urlViolations.length > 0) {
    const { warnings, hardFailReason } = await scanExternalUrlRefs(rawContent)
    if (hardFailReason) {
      throw new GitHubImportError('SCAN_FAILED', hardFailReason)
    }
    scanWarnings = warnings
  }

  // Infer pack_id (SEC-05)
  // For Markdown packs: parsed.display_name comes from the first # heading in parseMarkdownPack.
  // Fall back to URL-based inference (parent directory name).
  const rawPackId = (parsed.id ?? parsed.display_name ?? parsed.name ?? inferPackIdFromUrl(parsedUrl))
  const pack_id   = toPackId(rawPackId)

  // Resolve GitHub owner + version (non-fatal, async)
  // Only works for raw.githubusercontent.com URLs (api.github.com paths have a different structure)
  const ghMeta = parsedUrl.hostname === 'raw.githubusercontent.com'
    ? await resolveGitHubMeta(parsedUrl)
    : { owner: '', version: '', commit_sha: '' }

  // Detect capability
  const { type: capabilityType, mcp_command } = detectCapability(parsed)

  // Build scaffolded fields (SEC-09: inferred = true when not found in source)
  const hasId          = !!(parsed.id ?? parsed.display_name ?? parsed.name)
  const hasVersion     = !!parsed.version
  const hasAuthor      = !!parsed.author
  const hasDescription = !!parsed.description
  const hasPrompt      = !!parsed.system_prompt
  const hasTags        = Array.isArray(parsed.tags) && parsed.tags.length > 0

  // Author: explicit field in pack > repo owner from URL > empty
  const inferredAuthor  = !hasAuthor && !!ghMeta.owner
  // Version: explicit field in pack > resolved from GitHub tags/commit > default
  const inferredVersion = !hasVersion

  const fields: Omit<GitHubImportPreview, 'source_url' | 'content_sha256' | 'content_size' | 'scan_violations' | 'has_inferred_fields'> = {
    pack_id:        { value: pack_id,                                              inferred: !hasId },
    name:           { value: parsed.display_name ?? parsed.name ?? pack_id,        inferred: !hasId },
    version:        { value: parsed.version ?? ghMeta.version,                     inferred: inferredVersion },
    author:         { value: parsed.author  ?? ghMeta.owner,                       inferred: inferredAuthor },
    description:    { value: parsed.description ?? '',                             inferred: !hasDescription },
    system_prompt:  { value: parsed.system_prompt ?? '',                           inferred: !hasPrompt },
    tags:           { value: hasTags ? (parsed.tags as string[]) : [],             inferred: !hasTags },
    capability_type: { value: capabilityType,                                      inferred: capabilityType === 'prompt_only' },
    mcp_command:    mcp_command ? { value: mcp_command, inferred: false } : null,
  }

  const has_inferred_fields = Object.values(fields).some(
    (f) => f !== null && (f as { inferred: boolean }).inferred,
  )

  return {
    source_url:     rawUrl,
    content_sha256,
    content_size:   Buffer.byteLength(rawContent),
    commit_sha:     ghMeta.commit_sha || undefined,
    ...fields,
    scan_violations: [],
    scan_warnings:   scanWarnings,
    has_inferred_fields,
  }
}
