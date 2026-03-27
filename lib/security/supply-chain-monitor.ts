// lib/security/supply-chain-monitor.ts
// Amendment 91.8 — supply chain attack detection and AuditLog notification.
//
// Detects events that indicate a potential supply chain compromise:
//   - Docker image tag rewritten (digest mismatch)
//   - Marketplace pack with bad GPG signature
//   - MCP skill binary changed (SHA256 mismatch)
//   - Update published to registry without matching GitHub release
//   - Dependency version drifted from lock file
//
// All events:
//   1. Logged immutably to AuditLog (same table used elsewhere)
//   2. Admin notified via UI banner (stored in AuditLog, polled by admin UI)
//   3. Automatic rollback triggered if severity = 'critical'

import { db } from '@/lib/db/client'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type SupplyChainEventType =
  | 'image_digest_mismatch'         // Docker tag was rewritten
  | 'pack_signature_invalid'        // GPG verification of marketplace pack failed
  | 'pack_hash_mismatch'            // SHA-256 content hash mismatch at install
  | 'mcp_skill_hash_mismatch'       // MCP skill binary changed since registration
  | 'update_without_github_release' // image pushed to registry with no matching git tag
  | 'dependency_version_mismatch'   // installed dep version != lock file
  | 'litellm_version_drift'         // LiteLLM not on pinned version

export type SupplyChainSeverity = 'warning' | 'critical'

const SEVERITY_MAP: Record<SupplyChainEventType, SupplyChainSeverity> = {
  image_digest_mismatch:         'critical',
  pack_signature_invalid:        'critical',
  pack_hash_mismatch:            'critical',
  mcp_skill_hash_mismatch:       'critical',
  update_without_github_release: 'warning',
  dependency_version_mismatch:   'warning',
  litellm_version_drift:         'critical',
}

export interface SupplyChainEvent {
  event_type: SupplyChainEventType
  /** Human-readable description of the specific anomaly. */
  detail:     string
  /** Context — package name, image tag, skill name, etc. */
  context?:   Record<string, string>
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a supply chain security event to the immutable AuditLog.
 *
 * The AuditLog table is append-only (PostgreSQL RULE prevents UPDATE/DELETE),
 * so these records cannot be tampered with by a compromised process.
 *
 * @param event  - The supply chain event descriptor
 * @param actorId - The user_id or service identifier (e.g. 'system')
 */
export async function recordSupplyChainEvent(
  event:   SupplyChainEvent,
  actorId = 'system',
): Promise<void> {
  const severity = SEVERITY_MAP[event.event_type]

  try {
    await db.auditLog.create({
      data: {
        actor_id:    actorId,
        action_type: `supply_chain.${event.event_type}`,
        target_type: 'system',
        target_id:   null,
        payload: {
          severity,
          detail:  event.detail,
          context: event.context ?? {},
        },
      },
    })
  } catch (err) {
    // AuditLog write failing is itself a concern — log to stderr at minimum.
    console.error('[supply-chain-monitor] CRITICAL: AuditLog write failed:', err)
    console.error('[supply-chain-monitor] Original event:', event)
  }
}

/**
 * Wrapper — record an image digest mismatch event.
 * Called by lib/updates/verify-update.ts when digest check fails.
 */
export async function reportImageDigestMismatch(opts: {
  imageTag:  string
  expected:  string
  actual:    string
}): Promise<void> {
  await recordSupplyChainEvent({
    event_type: 'image_digest_mismatch',
    detail: `Docker image tag potentially hijacked: ${opts.imageTag}. Expected digest ${opts.expected}, got ${opts.actual}.`,
    context: {
      image_tag: opts.imageTag,
      expected:  opts.expected,
      actual:    opts.actual,
    },
  })
}

/**
 * Wrapper — record a marketplace pack GPG signature failure.
 * Called by lib/marketplace/install-pack.ts.
 */
export async function reportPackSignatureInvalid(opts: {
  packId:   string
  version:  string
  reason:   string
}): Promise<void> {
  await recordSupplyChainEvent({
    event_type: 'pack_signature_invalid',
    detail: `Pack "${opts.packId}@${opts.version}" failed GPG signature verification: ${opts.reason}`,
    context: {
      pack_id: opts.packId,
      version: opts.version,
      reason:  opts.reason,
    },
  })
}

/**
 * Wrapper — report a content hash mismatch for a marketplace pack.
 * Called by lib/marketplace/install-pack.ts.
 */
export async function reportPackHashMismatch(opts: {
  packId:   string
  version:  string
  expected: string
  actual:   string
}): Promise<void> {
  await recordSupplyChainEvent({
    event_type: 'pack_hash_mismatch',
    detail: `Pack "${opts.packId}@${opts.version}" content hash mismatch — possible tampering.`,
    context: {
      pack_id:  opts.packId,
      version:  opts.version,
      expected: opts.expected,
      actual:   opts.actual,
    },
  })
}

/**
 * Wrapper — report an MCP skill SHA256 mismatch at startup.
 * Called by lib/bootstrap/verify-mcp-skills.ts.
 */
export async function reportMCPSkillHashMismatch(opts: {
  skillName: string
  version:   string
  expected:  string
  actual:    string
}): Promise<void> {
  await recordSupplyChainEvent({
    event_type: 'mcp_skill_hash_mismatch',
    detail: `MCP skill "${opts.skillName}@${opts.version}" SHA256 mismatch at startup — skill may have been tampered with.`,
    context: {
      skill_name: opts.skillName,
      version:    opts.version,
      expected:   opts.expected,
      actual:     opts.actual,
    },
  })
}

/**
 * Wrapper — report an update pushed to registry without a matching GitHub tag.
 */
export async function reportUpdateWithoutRelease(opts: {
  version:   string
  imageTag:  string
}): Promise<void> {
  await recordSupplyChainEvent({
    event_type: 'update_without_github_release',
    detail: `Update for v${opts.version} (${opts.imageTag}) has no matching GitHub release — update rejected.`,
    context: {
      version:   opts.version,
      image_tag: opts.imageTag,
    },
  })
}

/**
 * Wrapper — report LiteLLM version drift from pinned value.
 */
export async function reportLiteLLMVersionDrift(opts: {
  expected: string
  actual:   string
}): Promise<void> {
  await recordSupplyChainEvent({
    event_type: 'litellm_version_drift',
    detail: `LiteLLM is running version ${opts.actual} but config pins ${opts.expected}. This may indicate a supply chain attack (cf. LiteLLM PyPI incident March 2026).`,
    context: {
      expected: opts.expected,
      actual:   opts.actual,
    },
  })
}
