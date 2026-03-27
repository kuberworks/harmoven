// lib/utils/input-validation.ts
// Input validation guards for all externally-sourced values used in
// child process arguments, channel names, and file paths.
// Spec: Amendment 92 (C1 command injection hardening).
//
// Security model:
//   All values from user input, HTTP requests, or LLM outputs MUST be
//   validated through one of these functions before being passed to:
//     - execFile() argument arrays
//     - pg_notify channel names
//     - filesystem path operations
//
// Functions throw ValidationError on failure — callers must handle.
// Never silently coerce or truncate — rejection is the only safe choice.

// ─── Error type ───────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

// ─── Git ref ──────────────────────────────────────────────────────────────────

// Safe git ref: branches, tags, commit SHAs.
// Allow: alphanumeric, /, ., -, _  — max 256 chars.
// Block: ;, &, |, $, (, ), `, \, newlines, spaces, NUL.
const SAFE_REF_RE = /^[a-zA-Z0-9._\-\/]{1,256}$/

export function assertSafeRef(ref: string): void {
  if (typeof ref !== 'string' || !SAFE_REF_RE.test(ref)) {
    throw new ValidationError(`Unsafe git ref: "${String(ref).slice(0, 50)}"`)
  }
}

// ─── Git branch name ──────────────────────────────────────────────────────────

// Stricter than ref: must start with alphanumeric, no .lock suffix.
const SAFE_BRANCH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-\/]{0,254}$/

export function assertSafeBranchName(branch: string): void {
  if (
    typeof branch !== 'string' ||
    !SAFE_BRANCH_RE.test(branch) ||
    branch.endsWith('.lock')
  ) {
    throw new ValidationError(
      `Unsafe branch name: "${String(branch).slice(0, 50)}"`
    )
  }
}

// ─── URL ─────────────────────────────────────────────────────────────────────

// Allow only https://, http://, git://, ssh://, git@ — block file:// etc.
const SAFE_URL_RE = /^(https?:\/\/|git:\/\/|ssh:\/\/|git@)/

export function assertSafeUrl(url: string): void {
  if (typeof url !== 'string' || !SAFE_URL_RE.test(url)) {
    throw new ValidationError(
      `Unsafe URL protocol: "${String(url).slice(0, 80)}"`
    )
  }
  // Credentials embedded in URLs are a security smell — block them.
  if (url.includes('@') && url.startsWith('http')) {
    // Only block user:pass@ patterns in http(s) — git@ is fine.
    const parsed = (() => { try { return new URL(url) } catch { return null } })()
    if (parsed?.username) {
      throw new ValidationError(
        `Credentials in URL are not allowed: "${url.slice(0, 80)}"`
      )
    }
  }
}

// ─── Filesystem path ──────────────────────────────────────────────────────────

export function assertSafePath(p: string): void {
  if (!p || typeof p !== 'string') {
    throw new ValidationError('Path must be a non-empty string')
  }
  if (p.includes('\0')) {
    throw new ValidationError(`Path contains null byte: "${p.slice(0, 80)}"`)
  }
  // Check raw segments before normalization — ../ that normalize() resolves away
  const rawSegments = p.split(/[\/\\]/)
  if (rawSegments.includes('..')) {
    throw new ValidationError(`Path traversal detected: "${p.slice(0, 80)}"`)
  }
}

// ─── UUID ─────────────────────────────────────────────────────────────────────

// Matches both UUID v4 (strict) and general UUID-shaped strings.
// Used for pg_notify channel names and DB row IDs.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertUUID(id: string): void {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new ValidationError(
      `Expected UUID, got: "${String(id).slice(0, 50)}"`
    )
  }
}

// ─── Convenience test functions (non-throwing) ────────────────────────────────

export function isSafeRef(ref: string): boolean {
  try { assertSafeRef(ref); return true } catch { return false }
}

export function isSafeBranchName(branch: string): boolean {
  try { assertSafeBranchName(branch); return true } catch { return false }
}

export function isUUID(id: string): boolean {
  try { assertUUID(id); return true } catch { return false }
}
