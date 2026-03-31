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

  /** Full scan violations — always empty on success (scan passed to get here). */
  scan_violations: string[]
  /** True if any field is inferred (triggers mandatory review badge in UI). */
  has_inferred_fields: boolean
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

  // Markdown / plain text → treat entire content as system_prompt
  if (ext === 'md' || ext === 'txt' || ext === '') {
    return { system_prompt: raw }
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

  // Domain pack: has system_prompt + metadata
  if (parsed.system_prompt && (parsed.id ?? parsed.display_name ?? parsed.name)) {
    return { type: 'domain_pack', mcp_command: null }
  }

  // Fallback: prompt-only
  return { type: 'prompt_only', mcp_command: null }
}

// ─── Infer pack_id from URL path ──────────────────────────────────────────────

function inferPackIdFromUrl(parsedUrl: URL): string {
  // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
  // api.github.com/repos/<owner>/<repo>/contents/<path>
  const segments = parsedUrl.pathname.split('/').filter(Boolean)
  const repoName = parsedUrl.hostname === 'api.github.com'
    ? segments[2] ?? 'unknown'  // /repos/<owner>/<repo>/...
    : segments[1] ?? 'unknown'  // /<owner>/<repo>/...
  return toPackId(repoName)
}

// ─── SEC-04: Double scan ──────────────────────────────────────────────────────

function runDoubleScan(rawContent: string, parsed: ParsedPack): string[] {
  const violations: string[] = []

  // Pass 1: raw bytes before any interpretation
  const rawScan = scanPackContent(rawContent)
  if (!rawScan.passed) {
    violations.push(...rawScan.violations.map((v) => `[raw] ${v.reason}`))
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
  const scanViolations = runDoubleScan(rawContent, parsed)
  if (scanViolations.length > 0) {
    throw new GitHubImportError(
      'SCAN_FAILED',
      `Security scan found ${scanViolations.length} violation(s): ${scanViolations.join('; ')}`,
    )
  }

  // Infer pack_id (SEC-05)
  const rawPackId = (parsed.id ?? parsed.display_name ?? parsed.name ?? inferPackIdFromUrl(parsedUrl))
  const pack_id   = toPackId(rawPackId)

  // Detect capability
  const { type: capabilityType, mcp_command } = detectCapability(parsed)

  // Build scaffolded fields (SEC-09: inferred = true when not found in source)
  const hasId          = !!(parsed.id ?? parsed.display_name ?? parsed.name)
  const hasVersion     = !!parsed.version
  const hasAuthor      = !!parsed.author
  const hasDescription = !!parsed.description
  const hasPrompt      = !!parsed.system_prompt
  const hasTags        = Array.isArray(parsed.tags) && parsed.tags.length > 0

  const fields: Omit<GitHubImportPreview, 'source_url' | 'content_sha256' | 'content_size' | 'scan_violations' | 'has_inferred_fields'> = {
    pack_id:        { value: pack_id,                                    inferred: !hasId },
    name:           { value: parsed.display_name ?? parsed.name ?? pack_id, inferred: !hasId },
    version:        { value: parsed.version ?? '0.1.0',                  inferred: !hasVersion },
    author:         { value: parsed.author ?? '',                         inferred: !hasAuthor },
    description:    { value: parsed.description ?? '',                    inferred: !hasDescription },
    system_prompt:  { value: parsed.system_prompt ?? '',                  inferred: !hasPrompt },
    tags:           { value: hasTags ? (parsed.tags as string[]) : [],   inferred: !hasTags },
    capability_type: { value: capabilityType,                             inferred: capabilityType === 'prompt_only' },
    mcp_command:    mcp_command ? { value: mcp_command, inferred: false } : null,
  }

  const has_inferred_fields = Object.values(fields).some(
    (f) => f !== null && (f as { inferred: boolean }).inferred,
  )

  return {
    source_url:     rawUrl,
    content_sha256,
    content_size:   Buffer.byteLength(rawContent),
    ...fields,
    scan_violations: [],
    has_inferred_fields,
  }
}
