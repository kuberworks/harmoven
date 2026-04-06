// lib/bootstrap/setup-token.ts
// One-time setup token — protects POST /api/setup/admin during first-run wizard.
//
// TOKEN SOURCE — resolved in this order:
//
//   1. HARMOVEN_SETUP_TOKEN env var (operator-defined, set in .env before launch).
//      The operator knows the token before starting the server, so the setup URL
//      is predictable.  Recommended for Docker Compose, CI/CD, and scripted deploys.
//      Minimum length: 20 characters.
//
//   2. Random generation (default fallback).
//      128 bits of entropy (crypto.randomBytes(16) → 32 hex chars).
//      Printed to stdout in Docker logs — requires the operator to run
//      `docker compose logs app | grep "Setup URL"` to retrieve it.
//
// Security properties (both modes):
//   - Timing-safe comparison via crypto.timingSafeEqual()
//   - Single-use: token is nullified immediately after first successful verification
//   - Generated only when userCount === 0 to avoid log spam on subsequent restarts
//   - HARMOVEN_SETUP_TOKEN equivalence: .env already stores AUTH_SECRET, DATABASE_URL,
//     POSTGRES_PASSWORD — a compromised .env is a total instance compromise regardless.
//     Adding the setup token there does NOT weaken the security model.

import crypto from 'crypto'

// ─── Internal state ───────────────────────────────────────────────────────────
//
// IMPORTANT — stored on globalThis, NOT as module-scoped variables.
//
// Next.js webpack bundling can load this module as two separate chunk instances:
// one in the instrumentation context (where generateSetupToken writes the token)
// and one in the Server Component context (where peekSetupToken reads it).
// Module-scoped `let` variables are NOT shared between chunks.
// globalThis IS shared across all chunks in the same Node.js process, so it
// acts as the single source of truth regardless of which chunk instance runs.
//
// Pattern mirrors lib/db/client.ts which uses the same globalThis trick to
// prevent multiple Prisma client instances under Next.js HMR.

interface SetupTokenState {
  token:    Buffer | null   // random-generated token
  envRaw:   string | null   // HARMOVEN_SETUP_TOKEN value
  consumed: boolean
}

const g = globalThis as unknown as { __hvSetupToken?: SetupTokenState }
if (!g.__hvSetupToken) {
  g.__hvSetupToken = { token: null, envRaw: null, consumed: false }
}
const state = g.__hvSetupToken

// ─── Minimum-length guard ─────────────────────────────────────────────────────

const ENV_TOKEN_MIN_LENGTH = 20

/**
 * Returns true if the HARMOVEN_SETUP_TOKEN value is valid for use.
 * Intentionally kept simple: length + printable-ASCII check.
 * We do NOT enforce complexity — the operator knows this is a secret.
 */
function isValidEnvToken(t: string): boolean {
  if (t.length < ENV_TOKEN_MIN_LENGTH) return false
  // Allow only printable ASCII (0x21–0x7E) so the token is safe in URLs
  // and shell scripts without quoting issues.
  return /^[\x21-\x7E]+$/.test(t)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the current raw token string (hex for random, literal for env var).
 *  Used only for printing the setup URL — never exposed via HTTP. */
function currentTokenString(): string {
  if (state.envRaw !== null) return encodeURIComponent(state.envRaw)
  if (state.token  !== null) return state.token.toString('hex')
  return ''
}

/** Generate the setup token (idempotent — no-op if already generated or consumed). */
export function generateSetupToken(): void {
  if (state.token !== null || state.envRaw !== null || state.consumed) return

  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const bar  = '━'.repeat(62)

  const envToken = process.env.HARMOVEN_SETUP_TOKEN?.trim() ?? ''

  if (envToken) {
    if (!isValidEnvToken(envToken)) {
      // Env var is set but invalid — warn loudly and fall back to random.
      console.warn(`\n[Harmoven] WARNING: HARMOVEN_SETUP_TOKEN is set but invalid.`)
      console.warn(`[Harmoven]   Reason: must be ≥${ENV_TOKEN_MIN_LENGTH} printable ASCII characters.`)
      console.warn(`[Harmoven]   Falling back to randomly-generated token.\n`)
    } else {
      state.envRaw = envToken
      console.log(`\n[Harmoven] ${bar}`)
      console.log(`[Harmoven]  Setup URL: ${base}/setup?token=${currentTokenString()}`)
      console.log(`[Harmoven]  Token source: HARMOVEN_SETUP_TOKEN env var`)
      console.log(`[Harmoven]  Single-use — expires after first successful setup.`)
      console.log(`[Harmoven] ${bar}\n`)
      return
    }
  }

  // Default: random 128-bit token
  state.token = crypto.randomBytes(16)
  // Belt-and-suspenders: also write to process.env so peekSetupToken() can read
  // the token even in edge cases where webpack module layers produce separate
  // module instances (each with their own `state` const reference).
  // process.env is a plain Node.js process property — guaranteed shared across
  // ALL modules in the same process, regardless of bundler isolation.
  // Cleared on consumption (verifyAndConsumeSetupToken) and on subsequent startups
  // (state.consumed=false and state.token=null mean we'd regenerate a new token).
  process.env.__HV_SETUP_TOKEN_CACHE = state.token.toString('hex')
  console.log(`\n[Harmoven] ${bar}`)
  console.log(`[Harmoven]  Setup URL: ${base}/setup?token=${currentTokenString()}`)
  console.log(`[Harmoven]  Open this URL in your browser to complete first-run setup.`)
  console.log(`[Harmoven]  Replace "localhost:3000" with your server address if needed.`)
  console.log(`[Harmoven]  Tip: set HARMOVEN_SETUP_TOKEN in .env for a predictable URL.`)
  console.log(`[Harmoven]  Single-use — expires after first successful setup.`)
  console.log(`[Harmoven] ${bar}\n`)
}

/**
 * Return the current token string without consuming it.
 * Used exclusively by the /setup Server Component to auto-inject the token
 * into the page URL via a server-side redirect — no HTTP API, no network hop.
 *
 * Returns null only when setup is already complete (token consumed) or when
 * the DB is genuinely unavailable (maybeGenerateSetupToken throws and
 * no HARMOVEN_SETUP_TOKEN env var is set).
 *
 * The returned string matches what is printed in Docker logs and what
 * verifyAndConsumeSetupToken() expects:
 *   - env-var mode: raw token string (caller should encodeURIComponent it)
 *   - random mode:  32-char lowercase hex string
 */
export async function peekSetupToken(): Promise<string | null> {
  if (state.consumed) return null
  if (state.envRaw !== null) return state.envRaw
  if (state.token  !== null) return state.token.toString('hex')
  // Belt-and-suspenders: check process.env cache in case webpack created
  // separate module instances per chunk (different `state` references).
  const cached = process.env.__HV_SETUP_TOKEN_CACHE
  if (cached) return cached

  // Token not yet in memory — instrumentation.ts may not have finished its
  // async DB query yet (startup race condition).  Generate now if needed.
  // generateSetupToken() is idempotent: safe to call concurrently.
  await maybeGenerateSetupToken().catch(() => { /* DB unavailable — handled below */ })

  if (state.envRaw !== null) return state.envRaw
  if (state.token  !== null) return (state.token as Buffer).toString('hex')
  return process.env.__HV_SETUP_TOKEN_CACHE ?? null
}

/**
 * Check user count and generate a setup token if no admin exists yet.
 * Called from instrumentation.ts at server startup.
 */
export async function maybeGenerateSetupToken(): Promise<void> {
  const { db } = await import('@/lib/db/client')
  // Check SystemSetting rather than user.count() so that bootstrap seed users
  // (created by `npm run db:seed`) do not suppress token generation.
  // The wizard writes 'setup.wizard_complete' = 'true' only after the operator
  // has fully completed the first-run form — until then, a token must be issued.
  const setting = await db.systemSetting.findUnique({ where: { key: 'setup.wizard_complete' } })
  if (setting?.value === 'true') return   // setup already complete — no token needed
  generateSetupToken()
}

/**
 * Verify the supplied token string against the stored token with a timing-safe
 * comparison.  If valid, consumes the token (single-use) and returns true.
 * Returns false if the token is wrong, already consumed, or was never generated.
 */
export function verifyAndConsumeSetupToken(candidate: string): boolean {
  if (state.consumed) return false

  // ── Env-var token path ───────────────────────────────────────────────────────
  if (state.envRaw !== null) {
    // URL-decode the candidate (the wizard sends encodeURIComponent output via the URL,
    // browser and fetch naturally decode it before reaching the server — but be explicit).
    const decodedCandidate = (() => {
      try { return decodeURIComponent(candidate) } catch { return candidate }
    })()
    const a = Buffer.from(decodedCandidate)
    const b = Buffer.from(state.envRaw)
    // timingSafeEqual requires same length — different length = immediate reject.
    if (a.length !== b.length) return false
    const ok = crypto.timingSafeEqual(a, b)
    if (ok) { state.consumed = true; state.envRaw = null; delete process.env.__HV_SETUP_TOKEN_CACHE }
    return ok
  }

  // ── Random token path (hex) ──────────────────────────────────────────────────
  if (state.token === null) return false

  const expected     = state.token                          // 16 bytes
  const candidateBuf = Buffer.from(candidate, 'hex')
  if (candidateBuf.length !== expected.length) return false

  const ok = crypto.timingSafeEqual(candidateBuf, expected)
  if (ok) {
    state.consumed = true
    state.token    = null
    delete process.env.__HV_SETUP_TOKEN_CACHE
  }
  return ok
}
