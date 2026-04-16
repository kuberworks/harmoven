// lib/marketplace/resolve-github-url.ts
// URL normalisation + GitHub API directory fetch for repo/branch/path URLs (B.2.1–B.2.2).
//
// Normalises any GitHub URL variant to either:
//   - a single raw file URL (raw.githubusercontent.com)
//   - a GitHub Contents API URL (api.github.com/repos/…/contents/…?ref=…)
//
// Security controls:
//   SEC-01  Hostname validated against GitUrlWhitelistEntry (DB+micromatch, no DNS)
//   SEC-02  fetch with redirect:'error' + AbortSignal.timeout(10_000) + 5 MB streaming cap
//   SEC-36  DNS pinning for external fetches (assertNotPrivateHost resolves once)
//   SEC-07  Rate limit: 10 repo analyses/h per userId (enforced at route level)

import { createHash } from 'node:crypto'
import micromatch from 'micromatch'
import { db } from '@/lib/db/client'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import { resolveGitToken } from './git-provider-tokens'

// ─── Types ────────────────────────────────────────────────────────────────────

export type NormalizedGitUrl =
  | { kind: 'single_file'; rawUrl: string; filename: string }
  | { kind: 'repo_dir';    apiUrl: string; owner: string; repo: string; ref: string; path: string }

export interface DirectoryEntry {
  name:   string
  type:   'file' | 'dir'
  path:   string
  sha:    string
  size:   number
}

export interface RepoContentsResult {
  entries:  DirectoryEntry[]
  apiUrl:   string
  owner:    string
  repo:     string
  ref:      string
  path:     string
}

const MAX_ENTRIES = 200
const MAX_BYTES   = 5_000_000 // 5 MB cap for content fetches

// ─── URL normalisation (B.2.1) ────────────────────────────────────────────────

export function normalizeGitUrl(rawInput: string): NormalizedGitUrl {
  let input = rawInput.trim()

  // Strip .git suffix
  input = input.replace(/\.git$/, '')

  // Ensure https:// prefix
  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    input = 'https://' + input
  }

  const url = new URL(input)
  const { hostname, pathname } = url

  // Block non-https
  if (url.protocol !== 'https:') {
    throw new GitUrlError('FORBIDDEN_PROTOCOL', `Only https:// is allowed, got: ${url.protocol}`)
  }

  // Block git:// and ssh://
  if (input.startsWith('git://') || input.startsWith('ssh://')) {
    throw new GitUrlError('FORBIDDEN_PROTOCOL', 'git:// and ssh:// URLs are not supported')
  }

  // Single file: raw.githubusercontent.com or /blob/<ref>/<path>
  if (hostname === 'raw.githubusercontent.com') {
    return { kind: 'single_file', rawUrl: url.toString(), filename: pathname.split('/').pop() ?? 'file' }
  }

  // /blob/ → convert to raw.githubusercontent.com
  const blobMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/)
  if (blobMatch) {
    const [, owner, repo, ref, filePath] = blobMatch as [string, string, string, string, string]
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`
    return { kind: 'single_file', rawUrl, filename: filePath.split('/').pop() ?? 'file' }
  }

  // github.com repo/tree/branch/path
  if (hostname === 'github.com') {
    // /owner/repo/tree/<ref>[/<path>]
    const treeMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/)
    if (treeMatch) {
      const [, owner, repo, ref, subPath] = treeMatch as [string, string, string, string, string]
      const apiUrl = buildContentsApiUrl(owner, repo, subPath, ref)
      return { kind: 'repo_dir', apiUrl, owner, repo, ref, path: subPath }
    }

    // /owner/repo (default branch)
    const repoMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
    if (repoMatch) {
      const [, owner, repo] = repoMatch as [string, string, string]
      const apiUrl = buildContentsApiUrl(owner, repo, '', '')
      return { kind: 'repo_dir', apiUrl, owner, repo, ref: '', path: '' }
    }
  }

  throw new GitUrlError('UNSUPPORTED_URL', `Cannot normalise URL: ${rawInput.slice(0, 200)}`)
}

function buildContentsApiUrl(owner: string, repo: string, path: string, ref: string): string {
  let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`
  if (path) url += `/${encodeURIComponent(path).replace(/%2F/g, '/')}`
  if (ref) url += `?ref=${encodeURIComponent(ref)}`
  return url
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class GitUrlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GitUrlError'
  }
}

// ─── Whitelist validation (SEC-01) ───────────────────────────────────────────

export async function assertHostWhitelisted(hostname: string): Promise<void> {
  const entries = await db.gitUrlWhitelistEntry.findMany({
    where: { enabled: true },
    select: { pattern: true },
  })
  const patterns = entries.map((e) => e.pattern)
  // micromatch matches on hostname string only — no DNS resolution (SEC-01)
  if (!micromatch.isMatch(hostname, patterns)) {
    throw new GitUrlError(
      'FORBIDDEN_HOST',
      `Host "${hostname}" is not in the Git URL whitelist`,
    )
  }
}

// ─── Capped fetch with DNS pinning (SEC-02, SEC-36) ─────────────────────────

export async function fetchCappedJson<T>(url: string, userId?: string): Promise<T> {
  // SSRF check (resolves DNS once — pin) + private IP block
  await assertNotPrivateHost(url)

  const parsed = new URL(url)
  const token = userId ? await resolveGitToken(parsed.hostname) : undefined
  const headers: Record<string, string> = {
    'User-Agent': 'Harmoven/2.0 (+https://harmoven.com)',
    'Accept':     'application/json',
  }
  if (token) headers['Authorization'] = token

  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'error',
      signal:   AbortSignal.timeout(10_000),
      headers,
    })
  } catch (e) {
    throw new GitUrlError('FETCH_FAILED', `fetch error: ${String(e).slice(0, 200)}`)
  }

  if (!res.ok) {
    throw new GitUrlError('FETCH_FAILED', `HTTP ${res.status} fetching ${parsed.hostname}`)
  }

  const text = await readCapped(res)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GitUrlError('PARSE_FAILED', 'Response is not valid JSON')
  }
}

export async function fetchCappedText(url: string, userId?: string): Promise<string> {
  await assertNotPrivateHost(url)
  const parsed = new URL(url)
  const token = userId ? await resolveGitToken(parsed.hostname) : undefined
  const headers: Record<string, string> = {
    'User-Agent': 'Harmoven/2.0 (+https://harmoven.com)',
  }
  if (token) headers['Authorization'] = token

  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'error',
      signal:   AbortSignal.timeout(10_000),
      headers,
    })
  } catch (e) {
    throw new GitUrlError('FETCH_FAILED', `fetch error: ${String(e).slice(0, 200)}`)
  }
  if (!res.ok) {
    throw new GitUrlError('FETCH_FAILED', `HTTP ${res.status} from ${parsed.hostname}`)
  }
  return readCapped(res)
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) throw new GitUrlError('FETCH_FAILED', 'Empty response body')
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) {
        throw new GitUrlError('CONTENT_TOO_LARGE', `Response exceeds ${MAX_BYTES} byte cap`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf)
}

// ─── Directory listing fetch (B.2.2) ─────────────────────────────────────────

export async function fetchRepoContents(
  normalized: NormalizedGitUrl & { kind: 'repo_dir' },
  userId?: string,
): Promise<RepoContentsResult> {
  if (normalized.kind !== 'repo_dir') throw new Error('Expected repo_dir')

  await assertHostWhitelisted('github.com')

  const data = await fetchCappedJson<DirectoryEntry[]>(normalized.apiUrl, userId)

  if (!Array.isArray(data)) {
    throw new GitUrlError('PARSE_FAILED', 'GitHub Contents API did not return an array')
  }

  const entries = data.slice(0, MAX_ENTRIES).map((e) => ({
    name: e.name,
    type: e.type,
    path: e.path,
    sha:  e.sha,
    size: e.size,
  }))

  return {
    entries,
    apiUrl:  normalized.apiUrl,
    owner:   normalized.owner,
    repo:    normalized.repo,
    ref:     normalized.ref,
    path:    normalized.path,
  }
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

export function sha256hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
