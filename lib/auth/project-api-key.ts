// lib/auth/project-api-key.ts
// ProjectApiKey lifecycle — Amendment 78 / Am.42.10
//
// Key format:   hv1_{32 random hex chars}
// Storage:      SHA-256(raw_key) stored in key_hash — raw key NEVER persisted.
// Comparison:   timingSafeEqual(sha256(provided), storedHash) — defeats timing attacks.
// Lifecycle:    create (returns raw key once), revoke (soft-delete via revoked_at).

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db/client'

/** Generate a new hv1_ prefixed API key and return raw key + its SHA-256 hash. */
function generateApiKey(): { rawKey: string; keyHash: string } {
  const suffix = randomBytes(16).toString('hex') // 32 hex chars
  const rawKey = `hv1_${suffix}`
  const keyHash = createHash('sha256').update(rawKey).digest('hex')
  return { rawKey, keyHash }
}

export interface CreateApiKeyOptions {
  projectId: string
  roleId: string
  name: string
  createdBy: string
  expiresAt?: Date
}

export interface CreateApiKeyResult {
  id: string
  name: string
  rawKey: string // Shown once — never call again after returning to caller
  createdAt: Date
  expiresAt: Date | null
}

/**
 * Create a new ProjectApiKey.
 * The raw key is returned ONCE in the result — it is never persisted.
 * Callers must display it immediately and discard it.
 */
export async function createProjectApiKey(
  opts: CreateApiKeyOptions,
): Promise<CreateApiKeyResult> {
  const { rawKey, keyHash } = generateApiKey()

  const key = await db.projectApiKey.create({
    data: {
      project_id: opts.projectId,
      role_id:    opts.roleId,
      name:       opts.name,
      key_hash:   keyHash,
      created_by: opts.createdBy,
      expires_at: opts.expiresAt ?? null,
    },
    select: {
      id:         true,
      name:       true,
      created_at: true,
      expires_at: true,
    },
  })

  return {
    id:         key.id,
    name:       key.name,
    rawKey,
    createdAt:  key.created_at,
    expiresAt:  key.expires_at,
  }
}

/**
 * Revoke a ProjectApiKey by setting revoked_at to now.
 * Idempotent if already revoked.
 * Returns false if the key does not exist or belongs to a different project.
 */
export async function revokeProjectApiKey(
  keyId: string,
  projectId: string,
): Promise<boolean> {
  const key = await db.projectApiKey.findUnique({
    where: { id: keyId },
    select: { project_id: true, revoked_at: true },
  })
  if (!key || key.project_id !== projectId) return false

  if (!key.revoked_at) {
    await db.projectApiKey.update({
      where: { id: keyId },
      data:  { revoked_at: new Date() },
    })
  }
  return true
}

/**
 * Validate a raw API key string against stored hashes.
 * Uses timingSafeEqual to prevent timing attacks (defence-in-depth: SHA-256
 * lookup is already one-way, but equal-length constant-time compare guards
 * against any future refactor that might introduce an early return).
 * Updates last_used on success.
 * Returns the key row (with project_id) or null if invalid/revoked/expired.
 */
export async function validateApiKey(
  rawKey: string,
): Promise<{ id: string; project_id: string } | null> {
  if (!rawKey.startsWith('hv1_')) return null

  // Compute hash once — used for DB lookup and timingSafeEqual
  const providedHashHex = createHash('sha256').update(rawKey).digest('hex')

  const key = await db.projectApiKey.findFirst({
    where: {
      key_hash:   providedHashHex,
      revoked_at: null,
      OR: [
        { expires_at: null },
        { expires_at: { gt: new Date() } },
      ],
    },
    select: { id: true, project_id: true, key_hash: true },
  })

  if (!key) return null

  // Timing-safe comparison (defence-in-depth)
  const providedHashBuf = Buffer.from(providedHashHex)
  const storedHashBuf   = Buffer.from(key.key_hash)
  if (providedHashBuf.length !== storedHashBuf.length) return null
  if (!timingSafeEqual(providedHashBuf, storedHashBuf)) return null

  // Update last_used asynchronously — do not await to keep hot path fast.
  void db.projectApiKey.update({
    where: { id: key.id },
    data:  { last_used: new Date() },
  }).catch(() => { /* non-fatal */ })

  return { id: key.id, project_id: key.project_id }
}
