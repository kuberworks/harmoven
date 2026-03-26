// lib/execution/credential-scope.ts
// Ephemeral per-run credential scope — Amendment 92 (executor isolation).
//
// Problem: LLM provider API keys live in process.env and are accessible to
// any child process spawned by the executor. A compromised agent subprocess
// (e.g. via prompt injection) could read ANTHROPIC_API_KEY from process.env.
//
// Solution: CredentialVault issues short-lived, run-scoped tokens.
//   - Keys are decrypted from the DB only at run start.
//   - Each run receives ONLY the providers it actually needs.
//   - Tokens are held in-memory, not in process.env.
//   - They are revoked (deleted from memory) when the run ends.
//   - A compromised agent can only access keys for its own run.
//   - After the run, those tokens are gone — cannot be replayed.
//
// Security notes:
//   - In-memory storage: no persistence, no IPC exposure.
//   - TTL-based expiry: scope expires at run budget_minutes even if
//     revokeRunScope() is never called (safety net for crashed runs).
//   - Provider filtering: a run using only claude-haiku-4 gets zero access
//     to OpenAI or Google credentials.

// db is lazy-loaded inside issueRunScope() to avoid eager PrismaClient init
// (which requires DATABASE_URL at module load time — breaks unit tests).
import { createDecipheriv, createHash, type DecipherGCM } from 'node:crypto'

/** Add `minutes` minutes to the given date — inline to avoid date-fns dependency. */
function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunCredentialScope {
  run_id:     string
  expires_at: Date
  providers:  string[]
  /** provider name → ephemeral plaintext key for this run only */
  tokens:     Record<string, string>
}

// ─── Encryption helpers ───────────────────────────────────────────────────────

/**
 * Derive a 32-byte AES key from ENCRYPTION_KEY.
 * Uses SHA-256 of the env var so any string length works.
 */
function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('[CredentialVault] ENCRYPTION_KEY is not set')
  return createHash('sha256').update(raw).digest()
}

function decrypt(ciphertext: string): string {
  // Supported formats:
  //   plaintext (dev mode)  — no ':' character
  //   GCM (current)         — 'gcm:<ivHex12B>:<ciphertextHex>:<tagHex16B>'  (4 parts)
  //   CBC (legacy read-only) — '<ivHex16B>:<ciphertextHex>'                  (2 parts)
  //
  // SECURITY: GCM is the required format (Amendment 92 — AES-256-GCM).
  // CBC support is retained read-only for migrating existing DB records.
  // No new credentials are written in CBC format.
  if (!ciphertext.includes(':')) return ciphertext

  try {
    const parts = ciphertext.split(':')
    const key   = getEncryptionKey()

    if (parts[0] === 'gcm' && parts.length === 4) {
      // Current format: gcm:<ivHex(12B=24chars)>:<ciphertextHex>:<tagHex(16B=32chars)>
      const [, ivHex, encHex, tagHex] = parts
      const iv       = Buffer.from(ivHex!, 'hex')   // 12-byte IV (96 bits, GCM standard)
      const enc      = Buffer.from(encHex!, 'hex')
      const tag      = Buffer.from(tagHex!, 'hex')  // 16-byte authentication tag
      const decipher = createDecipheriv('aes-256-gcm', key, iv) as DecipherGCM
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    }

    if (parts.length === 2) {
      // Legacy CBC format — read-only path for migrating existing DB records.
      // DO NOT use this path for new encryptions.
      const [ivHex, encHex] = parts
      const iv       = Buffer.from(ivHex!, 'hex')
      const enc      = Buffer.from(encHex!, 'hex')
      const decipher = createDecipheriv('aes-256-cbc', key, iv)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    }

    // Unknown format — treat as plaintext
    return ciphertext
  } catch {
    // If decryption fails, return the raw value (handles dev plaintext mode)
    return ciphertext
  }
}

// ─── CredentialVault ─────────────────────────────────────────────────────────

class CredentialVault {
  // In-memory map — no DB writes for scope storage (security: no persistence)
  private readonly scopes = new Map<string, RunCredentialScope>()

  /**
   * Issue a credential scope for a run.
   * Called by DagExecutor when a run starts.
   *
   * @param runId       The run UUID
   * @param projectId   The project UUID (used to look up provider credentials)
   * @param providers   LLM provider names this run needs (e.g. ['anthropic'])
   * @param budgetMin   Expected run duration in minutes (TTL for the scope)
   */
  async issueRunScope(
    runId:     string,
    projectId: string,
    providers: string[],
    budgetMin  = 60,
  ): Promise<RunCredentialScope> {
    // Lazy-load db to avoid eager PrismaClient initialization at module load time
    const { db } = await import('@/lib/db/client')

    // Look up project credentials for required providers
    const tokens: Record<string, string> = {}

    for (const provider of providers) {
      // Try to find an encrypted provider key in the DB.
      // ProjectCredential.name is the symbolic name (e.g. 'anthropic', 'openai').
      // ProjectCredential.value_enc is the AES-256-GCM ciphertext (spec: Am.92).
      const cred = await db.projectCredential.findFirst({
        where:  { project_id: projectId, name: provider },
        select: { value_enc: true },
      }).catch(() => null)

      if (cred?.value_enc) {
        tokens[provider] = decrypt(cred.value_enc)
      } else {
        // Fall back to process.env (dev mode) — only if no DB record exists
        const envKey = `${provider.toUpperCase()}_API_KEY`
        const envVal = process.env[envKey]
        if (envVal) {
          tokens[provider] = envVal
        }
        // If neither exists, provider simply isn't available for this run
      }
    }

    const scope: RunCredentialScope = {
      run_id:     runId,
      expires_at: addMinutes(new Date(), budgetMin),
      providers,
      tokens,
    }

    this.scopes.set(runId, scope)
    return scope
  }

  /**
   * Get the ephemeral API key for a specific provider within a run.
   * Called by agent runners — NOT by reading process.env.
   *
   * @throws if no scope exists, if scope is expired, or if provider not in scope
   */
  getTokenForRun(runId: string, provider: string): string {
    const scope = this.scopes.get(runId)
    if (!scope) {
      throw new Error(`[CredentialVault] No credential scope for run ${runId}`)
    }
    if (scope.expires_at < new Date()) {
      this.scopes.delete(runId)
      throw new Error(
        `[CredentialVault] Credential scope expired for run ${runId}`
      )
    }
    const token = scope.tokens[provider]
    if (!token) {
      throw new Error(
        `[CredentialVault] Provider "${provider}" not in scope for run ${runId}`
      )
    }
    return token
  }

  /**
   * Revoke the credential scope for a run.
   * Called by DagExecutor on run completion or failure.
   * In-memory deletion — tokens are gone immediately.
   */
  revokeRunScope(runId: string): void {
    this.scopes.delete(runId)
  }

  /** Visible scope count — for diagnostics/testing only. */
  get activeScopes(): number {
    return this.scopes.size
  }

  /**
   * Garbage-collect expired scopes.
   * Called periodically (every few minutes) to prevent memory leaks
   * from crashed runs that never called revokeRunScope().
   */
  gcExpired(): number {
    let removed = 0
    const now = new Date()
    for (const [runId, scope] of this.scopes.entries()) {
      if (scope.expires_at < now) {
        this.scopes.delete(runId)
        removed++
      }
    }
    return removed
  }
}

/** Singleton instance — shared by all executors in the same process. */
export const credentialVault = new CredentialVault()

// GC interval: clean up expired scopes every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => credentialVault.gcExpired(), 5 * 60 * 1_000).unref?.()
}
