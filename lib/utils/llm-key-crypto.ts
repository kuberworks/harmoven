// lib/utils/llm-key-crypto.ts
// AES-256-GCM encrypt / decrypt helpers for LLM profile API keys stored in
// the `config.api_key_enc` column of the LlmProfile table.
//
// Uses the same key derivation (HKDF-SHA256 via deriveCredentialKey) and
// ciphertext format (gcm:<ivHex>:<ciphertextHex>:<tagHex>) as the credential vault
// so the same ENCRYPTION_KEY env var covers both features.
//
// SECURITY:
//   - Plaintext api_key is NEVER stored or logged.
//   - api_key_enc is NEVER returned by any API route.
//   - The decrypted key is only materialised at request time inside the LLM client.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CipherGCM, DecipherGCM }                   from 'node:crypto'
import { deriveCredentialKey }                            from './credential-crypto'

/**
 * Encrypt an LLM API key for storage in config.api_key_enc.
 * Requires ENCRYPTION_KEY env var (≥128 bits of entropy recommended).
 * Format: gcm:<ivHex12B>:<ciphertextHex>:<tagHex16B>
 */
export function encryptLlmKey(plaintext: string): string {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('[LlmKeyCrypto] ENCRYPTION_KEY is not set')
  const key    = deriveCredentialKey(raw)
  const iv     = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`
}

/**
 * Decrypt an LLM API key from config.api_key_enc.
 * Returns null if ENCRYPTION_KEY is unset or the ciphertext is invalid.
 */
export function decryptLlmKey(ciphertext: string): string | null {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) return null
  try {
    const parts = ciphertext.split(':')
    if (parts[0] !== 'gcm' || parts.length !== 4) return null
    const [, ivHex, encHex, tagHex] = parts
    const key      = deriveCredentialKey(raw)
    const iv       = Buffer.from(ivHex!, 'hex')
    const enc      = Buffer.from(encHex!, 'hex')
    const tag      = Buffer.from(tagHex!, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', key, iv) as DecipherGCM
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
