// lib/utils/credential-crypto-ext.ts
// Shared encrypt + decrypt helpers built on credential-crypto.ts.
// Used by marketplace v2 routes for registry auth_header_enc and git token_enc.
//
// Format: gcm:<ivHex12B>:<ciphertextHex>:<tagHex16B>  (AES-256-GCM, HKDF-derived key)
// Identical to the format in app/api/admin/credentials/route.ts encryptValue().

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CipherGCM, DecipherGCM } from 'node:crypto'
import { deriveCredentialKey, deriveLegacyCredentialKey } from './credential-crypto'

export function encryptValue(plaintext: string): string {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('[CredentialCrypto] ENCRYPTION_KEY is not set')
  const key    = deriveCredentialKey(raw)
  const iv     = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`
}

export function decryptValue(ciphertext: string): string {
  if (!ciphertext.includes(':')) return ciphertext  // plaintext (dev mode)

  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('[CredentialCrypto] ENCRYPTION_KEY is not set')

  const parts = ciphertext.split(':')

  // GCM format: gcm:<iv>:<enc>:<tag>
  if (parts[0] === 'gcm' && parts.length === 4) {
    const [, ivHex, encHex, tagHex] = parts as [string, string, string, string]
    const iv       = Buffer.from(ivHex, 'hex')
    const enc      = Buffer.from(encHex, 'hex')
    const tag      = Buffer.from(tagHex, 'hex')

    // Try HKDF key first
    try {
      const key      = deriveCredentialKey(raw)
      const decipher = createDecipheriv('aes-256-gcm', key, iv) as DecipherGCM
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    } catch {
      // Fallback: legacy SHA-256 key
      const legacyKey = deriveLegacyCredentialKey(raw)
      const decipher  = createDecipheriv('aes-256-gcm', legacyKey, iv) as DecipherGCM
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    }
  }

  throw new Error(`[CredentialCrypto] Unrecognised ciphertext format`)
}
