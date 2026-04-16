// lib/auth/api-key-validator.ts
// Standalone API key validator — Amendment 92 (timingSafeEqual for all key comparisons).
//
// NOTE: The full API key lifecycle (create, validate, revoke) is in
// lib/auth/project-api-key.ts which already uses timingSafeEqual correctly.
// This thin module re-exports the validation function under the spec-required
// path and adds a standalone form for callers that don't have DB access.
//
// Key design principles:
//   1. NEVER store or log raw API keys.
//   2. ALWAYS compare using timingSafeEqual — not === or localeCompare.
//   3. Hash the provided key before comparing (DB stores the hash only).
//   4. Fixed-length comparison prevents length-based timing oracles.

import { timingSafeEqual, createHash } from 'node:crypto'
import { validateApiKey as validateApiKeyFull } from '@/lib/auth/project-api-key'

// Re-export the full DB-backed validator
export { validateApiKeyFull as validateApiKey }

/**
 * Low-level constant-time comparison of two API key hashes.
 * Both inputs must be SHA-256 hex strings (64 chars).
 *
 * Returns false for any length mismatch — do NOT short-circuit on length
 * as that itself leaks information.
 *
 * @param providedKeyRaw  The raw key from the Authorization header (hv1_...)
 * @param storedKeyHash   The SHA-256 hex hash from the database
 */
export function compareApiKey(
  providedKeyRaw: string,
  storedKeyHash:  string,
): boolean {
  // Hash the provided key to match storage format
  const providedHash = createHash('sha256')
    .update(providedKeyRaw)
    .digest()                // Buffer, 32 bytes

  const storedHash = Buffer.from(storedKeyHash, 'hex')

  // Length must match before timingSafeEqual (it throws on mismatch)
  // Both should be 32 bytes (SHA-256) — any deviation is a bug or attack
  if (providedHash.length !== storedHash.length) return false

  return timingSafeEqual(providedHash, storedHash)
}

/**
 * Extract and validate an API key from an Authorization header value.
 * Expected format: "Bearer hv1_<32 hex chars>"
 *
 * Returns the raw key string (normalised to lowercase) if the format is valid,
 * null otherwise.
 * Does NOT hit the DB — that's done by validateApiKey().
 *
 * SEC: The key is normalised to lowercase so that clients sending mixed- or
 * upper-case keys (e.g. "Bearer HV1_ABCDEF...") still match the SHA-256 hash
 * stored in DB (which was computed from the lowercase canonical form at creation
 * time). The `i` flag on the regex is retained for the prefix match; the
 * `toLowerCase()` call on the captured group is the canonical normalisation.
 */
export function extractBearerKey(authHeader: string | null): string | null {
  if (!authHeader) return null
  const match = authHeader.match(/^Bearer\s+(hv1_[0-9a-f]{32})$/i)
  return match?.[1]?.toLowerCase() ?? null
}
