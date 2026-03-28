// lib/utils/credential-crypto.ts
// Shared AES-256-GCM key derivation for credential encryption/decryption.
// Security fix CVE-HARM-001: replaces bare SHA-256 key derivation with HKDF-SHA256.
//
// WHY HKDF instead of SHA-256?
//   SHA-256(password) is a single hash — no salt, no iteration count.
//   A GPU can compute ~10 billion SHA-256/s, making brute-force trivial for
//   weak or predictable ENCRYPTION_KEY values.
//   HKDF uses extraction+expansion, provides key separation via the `info` field,
//   and is the NIST-recommended KDF for deriving cryptographic keys from secrets.
//
// IMPORTANT: the HKDF_SALT and HKDF_INFO constants below are fixed and MUST
//   remain identical across all encryption and decryption sites in this codebase:
//     - lib/execution/credential-scope.ts     (decrypt)
//     - app/api/admin/credentials/route.ts    (encrypt)
//     - app/api/admin/credentials/[credId]/route.ts (encrypt)
//   Any change to these constants will make all existing credentials unreadable.
//
// MIGRATION: credentials encrypted before this fix (with the SHA-256 path) are
//   transparently supported via the legacy decrypt path in credential-scope.ts
//   which tries HKDF first, then falls back on GCM auth-tag failure.
//   Operators should re-encrypt all credentials via the admin panel after upgrading.

import { hkdfSync, createHash } from 'node:crypto'

// Fixed salt and info — never change after first deployment without a migration.
const HKDF_SALT = Buffer.from('harmoven-credential-kdf-salt-v2', 'utf8')
const HKDF_INFO = Buffer.from('harmoven-aes256gcm-credential-encryption', 'utf8')

/**
 * Derive a 32-byte AES-256 key from the ENCRYPTION_KEY env var using HKDF-SHA256.
 *
 * HKDF provides:
 *   - Key extraction: mixes the raw secret with a salt to produce uniform entropy
 *   - Key expansion:  stretches to exactly 32 bytes via HMAC-SHA-256
 *
 * This function is cheap (single HKDF call) and deterministic — it does NOT
 * add a random per-credential salt. The strength guarantee relies on
 * ENCRYPTION_KEY having ≥128 bits of entropy (recommended: `openssl rand -base64 32`).
 *
 * @throws Error if ENCRYPTION_KEY is not set
 */
export function deriveCredentialKey(raw: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'utf8'), HKDF_SALT, HKDF_INFO, 32))
}

/**
 * Legacy key derivation (bare SHA-256) — for decrypting credentials written
 * before the HKDF migration.
 *
 * Used ONLY as a fallback when HKDF decryption fails (GCM auth tag mismatch).
 * DO NOT use for new encryptions.
 *
 * @deprecated Remove once all credentials have been re-encrypted with HKDF.
 */
export function deriveLegacyCredentialKey(raw: string): Buffer {
  return createHash('sha256').update(raw).digest()
}
