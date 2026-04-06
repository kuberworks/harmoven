// lib/bootstrap/setup-token.ts
// One-time setup token — protects POST /api/setup/admin during first-run wizard.
//
// Generated at server startup when no admin account exists yet.
// Printed to stdout (visible in Docker logs) so the operator can copy it into
// the setup wizard.  Consumed (cleared) on the first valid use of POST /api/setup/admin.
//
// Security properties:
//   - 128 bits of entropy (crypto.randomBytes(16) → 32 hex chars)
//   - Timing-safe comparison via crypto.timingSafeEqual()
//   - Single-use: token is nullified immediately after first successful verification
//   - Generated only when userCount === 0 to avoid log spam on subsequent restarts

import crypto from 'crypto'

let _token: Buffer | null = null
let _consumed             = false

/** Generate the setup token (idempotent — no-op if already generated). */
export function generateSetupToken(): void {
  if (_token !== null || _consumed) return
  _token = crypto.randomBytes(16)
  const hex = _token.toString('hex')
  const bar = '━'.repeat(54)
  console.log(`\n[Harmoven] ${bar}`)
  console.log(`[Harmoven]  SETUP TOKEN: ${hex}`)
  console.log(`[Harmoven]  Open /setup and paste this token to continue.`)
  console.log(`[Harmoven]  Single-use — expires after first successful setup.`)
  console.log(`[Harmoven] ${bar}\n`)
}

/**
 * Check user count and generate a setup token if no admin exists yet.
 * Called from instrumentation.ts at server startup.
 */
export async function maybeGenerateSetupToken(): Promise<void> {
  const { db } = await import('@/lib/db/client')
  const count = await db.user.count()
  if (count > 0) return   // setup already complete — no token needed
  generateSetupToken()
}

/**
 * Verify the supplied token string against the stored token with a timing-safe
 * comparison.  If valid, consumes the token (single-use) and returns true.
 * Returns false if the token is wrong, already consumed, or was never generated.
 */
export function verifyAndConsumeSetupToken(candidate: string): boolean {
  if (_consumed || _token === null) return false

  // Pad both buffers to the same length before timingSafeEqual to avoid
  // argument-length side-channel.  An invalid-length candidate is rejected.
  const expected  = _token                              // 16 bytes
  const candidateBuf = Buffer.from(candidate, 'hex')
  if (candidateBuf.length !== expected.length) return false

  const ok = crypto.timingSafeEqual(candidateBuf, expected)
  if (ok) {
    _consumed = true
    _token    = null
  }
  return ok
}
