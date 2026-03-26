// lib/marketplace/install-pack.ts
// Pack installation, update, and uninstall logic.
// Spec: TECHNICAL.md §39.5, Amendment 67 (install/updates/overrides).
//
// Install flow (§39.5):
//   fetchFromRegistry → verifyContentHash → scanPackContent → installToDb
//   GPG signature verification is deferred to T3.8 (supply chain monitor).
//
// Security:
//   - SHA-256 content hash verified before DB write
//   - Prompt injection + external URL scanned (scanPackContent)
//   - Pack ID validated — alphanumeric + underscores only (no path traversal)
//   - Version validated — strict semver format
//   - Local overrides never silently overwritten on update (Am.67.4)

import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { scanPackContent } from '@/lib/marketplace/scan'
import type { PackManifest } from '@/lib/marketplace/types'

// ─── Input validation ─────────────────────────────────────────────────────────

/** Regexp for valid pack IDs: lowercase alphanumeric + underscores, 1–64 chars. */
const PACK_ID_RE   = /^[a-z0-9_]{1,64}$/
/** Strict semver: major.minor.patch — suffixes like -rc.1 rejected to keep DB simple. */
const SEMVER_RE    = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
/** SHA-256 hex: exactly 64 hex chars. */
const SHA256_RE    = /^[0-9a-f]{64}$/i

export class MarketplaceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'MarketplaceError'
  }
}

function assertPackId(packId: string): void {
  if (!PACK_ID_RE.test(packId)) {
    throw new MarketplaceError(
      `Invalid pack_id "${packId}" — must match ${PACK_ID_RE.source}`,
      'INVALID_PACK_ID',
    )
  }
}

function assertSemver(version: string): void {
  if (!SEMVER_RE.test(version)) {
    throw new MarketplaceError(
      `Invalid version "${version}" — must be major.minor.patch`,
      'INVALID_VERSION',
    )
  }
}

function assertSha256(hash: string): void {
  if (!SHA256_RE.test(hash)) {
    throw new MarketplaceError(
      `Invalid SHA-256 hash "${hash.slice(0, 16)}…"`,
      'INVALID_HASH',
    )
  }
}

// ─── Content hash verification ────────────────────────────────────────────────

function verifyContentHash(content: string, expectedHash: string): void {
  const actual = createHash('sha256').update(content).digest('hex')
  // Timing-safe: both strings are always 64 hex chars — constant-time comparison.
  const actualBuf   = Buffer.from(actual)
  const expectedBuf = Buffer.from(expectedHash.toLowerCase())
  if (actualBuf.length !== expectedBuf.length) {
    throw new MarketplaceError('Pack content hash mismatch — possible tampering', 'HASH_MISMATCH')
  }
  if (!timingSafeEqual(actualBuf, expectedBuf)) {
    throw new MarketplaceError('Pack content hash mismatch — possible tampering', 'HASH_MISMATCH')
  }
}

// ─── Registry fetch ───────────────────────────────────────────────────────────

/** Registry base URL — can be overridden via environment (e.g. mirror, air-gap). */
const REGISTRY_BASE = process.env.HARMOVEN_REGISTRY_URL ?? 'https://registry.harmoven.com/v1'

/**
 * Zod schema for PackManifest — validates the registry response at the boundary.
 * An attacker controlling the registry cannot send a malformed manifest that would
 * crash the install flow or pass a `null` sha256 to verifyContentHash().
 */
const PackManifestSchema = z.object({
  pack_id:         z.string().regex(/^[a-z0-9_]{1,64}$/),
  name:            z.string().min(1).max(256),
  version:         z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  author:          z.string().min(1).max(256),
  description:     z.string().max(4096),
  tags:            z.array(z.string().max(64)).max(32),
  content:         z.string().min(1).max(1_000_000),
  content_sha256:  z.string().regex(/^[0-9a-f]{64}$/i),
  signature:       z.string().optional(),
  bayesian_rating: z.number().min(0).max(5).optional(),
  install_count:   z.number().int().min(0).optional(),
}).strict()

/**
 * Fetch a pack manifest from the registry.
 * Note: SSRF protection is handled at the network level (Docker network policy)
 * since the registry base URL is a fixed config value, not user-supplied.
 * User-supplied URLs (e.g. custom registries) MUST go through assertNotPrivateHost() — deferred T3.9.
 */
async function fetchFromRegistry(packId: string, version: string): Promise<PackManifest> {
  const url = `${REGISTRY_BASE}/packs/${encodeURIComponent(packId)}/${encodeURIComponent(version)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Harmoven/1.0 (+https://harmoven.com)' },
    // 10 s timeout — registry should be fast
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new MarketplaceError(
      `Registry returned ${res.status} for ${packId}@${version}`,
      'REGISTRY_ERROR',
    )
  }

  // Validate Content-Type before parsing: a CloudFlare challenge page or HTML error
  // would otherwise crash res.json() or silently cast to PackManifest with undefined fields.
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new MarketplaceError(
      `Registry returned unexpected content type "${contentType.slice(0, 80)}" for ${packId}@${version}`,
      'REGISTRY_ERROR',
    )
  }

  const raw = await res.json()

  // Validate structure with Zod — prevents a compromised registry from injecting
  // null/undefined into security-critical fields (e.g. content_sha256).
  const parsed = PackManifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new MarketplaceError(
      `Registry manifest validation failed for ${packId}@${version}: ${parsed.error.message}`,
      'INVALID_MANIFEST',
    )
  }

  return parsed.data as PackManifest
}

// ─── Semver comparison helpers ────────────────────────────────────────────────

type SemverTuple = [number, number, number]

function parseSemver(v: string): SemverTuple {
  const [major, minor, patch] = v.split('.').map(Number)
  return [major ?? 0, minor ?? 0, patch ?? 0]
}

/** Returns 'major' | 'minor' | 'patch' | 'none' for the type of bump. */
function semverBumpType(from: string, to: string): 'major' | 'minor' | 'patch' | 'none' {
  const [fromMaj, fromMin] = parseSemver(from)
  const [toMaj,   toMin]   = parseSemver(to)
  if (toMaj > fromMaj) return 'major'
  if (toMin > fromMin) return 'minor'
  if (parseSemver(to)[2] > parseSemver(from)[2]) return 'patch'
  return 'none'
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface InstallPackOptions {
  packId:        string
  version:       string
  userId:        string
  /** null = user-level install (available in all workspaces) */
  workspaceId?:  string | null
  updatePolicy?: 'auto' | 'notify' | 'manual'
  scope?:        'workspace' | 'project'
  projectIds?:   string[]
}

/**
 * Install a pack from the marketplace registry.
 *
 * Flow:
 *   1. Validate inputs (packId, version, userId)
 *   2. Fetch manifest from registry
 *   3. Verify SHA-256 content hash (timing-safe)
 *   4. Scan content for prompt injection + external URLs
 *   5. Upsert InstalledPack row in DB
 *   6. Log to AuditLog
 *
 * GPG signature verification (step 2b in spec) is deferred to T3.8.
 */
export async function installPack(opts: InstallPackOptions): Promise<{ id: string }> {
  const {
    packId,
    version,
    userId,
    workspaceId  = null,
    updatePolicy = 'notify',
    scope        = 'workspace',
    projectIds   = [],
  } = opts

  // ── Input validation ──────────────────────────────────────────────────────
  assertPackId(packId)
  assertSemver(version)
  if (!userId || typeof userId !== 'string') {
    throw new MarketplaceError('userId is required', 'MISSING_USER_ID')
  }

  // ── Fetch from registry ───────────────────────────────────────────────────
  const manifest = await fetchFromRegistry(packId, version)

  // ── Hash verification (§39.5 step 3) ─────────────────────────────────────
  assertSha256(manifest.content_sha256)
  verifyContentHash(manifest.content, manifest.content_sha256)

  // ── Security scan (§39.5 step 4) ─────────────────────────────────────────
  const scan = scanPackContent(manifest.content)
  if (!scan.passed) {
    // Log failed scan attempt to AuditLog before throwing
    await db.auditLog.create({
      data: {
        actor:       userId,
        action_type: 'marketplace_scan_failed',
        payload: {
          pack_id: packId,
          version,
          reason:  scan.reason,
        },
      },
    }).catch(() => { /* non-fatal */ })

    throw new MarketplaceError(
      scan.reason ?? 'Pack failed security scan',
      scan.hasInjection ? 'INJECTION_DETECTED' : 'EXTERNAL_URL_DETECTED',
    )
  }

  // ── Install to DB (upsert — idempotent re-install) ────────────────────────
  const existing = await db.installedPack.findUnique({
    where: { user_id_pack_id: { user_id: userId, pack_id: packId } },
  })

  let record: { id: string }

  if (existing) {
    // Update — preserve local overrides, merge with new version
    record = await db.installedPack.update({
      where: { user_id_pack_id: { user_id: userId, pack_id: packId } },
      data: {
        version,
        update_policy: updatePolicy,
        scope,
        project_ids:   projectIds,
        // local_overrides preserved — never silently overwritten (Am.67.4)
        installed_at:  new Date(),
      },
      select: { id: true },
    })
  } else {
    record = await db.installedPack.create({
      data: {
        user_id:       userId,
        workspace_id:  workspaceId,
        pack_id:       packId,
        source:        'marketplace',
        version,
        update_policy: updatePolicy,
        // pinned_version and local_overrides default to null — omit to let Prisma handle it
        scope,
        project_ids:   projectIds,
        installed_by:  userId,
      },
      select: { id: true },
    })
  }

  // ── Audit log ─────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      actor:       userId,
      action_type: existing ? 'marketplace_update' : 'marketplace_install',
      payload: {
        pack_id:       packId,
        version,
        installed_pack_id: record.id,
      },
    },
  }).catch(() => { /* non-fatal */ })

  return record
}

// ─── Version check ────────────────────────────────────────────────────────────

export interface PackUpdateAvailable {
  pack_id:         string
  installed_version: string
  latest_version:  string
  bump_type:       'major' | 'minor' | 'patch'
  /** Whether auto-install is allowed per update_policy + bump_type */
  auto_installable: boolean
}

/**
 * Check installed packs for available updates.
 * Returns packs that have a newer version on the registry.
 *
 * major bumps → always notify, never auto (Am.67.3)
 * minor bumps → according to update_policy
 * patch bumps → auto if update_policy = 'auto'
 */
export async function checkPackUpdates(userId: string): Promise<PackUpdateAvailable[]> {
  const installed = await db.installedPack.findMany({
    where: { user_id: userId },
    select: { pack_id: true, version: true, update_policy: true, pinned_version: true },
  })

  const updates: PackUpdateAvailable[] = []

  for (const pack of installed) {
    // Skip pinned packs — user explicitly fixed the version
    if (pack.pinned_version) continue

    // Fetch latest version from registry (lightweight metadata call)
    let latest: PackManifest
    try {
      latest = await fetchFromRegistry(pack.pack_id, 'latest')
    } catch {
      // Registry unavailable or pack not found — skip silently
      continue
    }

    const bump = semverBumpType(pack.version, latest.version)
    if (bump === 'none') continue

    const autoInstallable =
      bump !== 'major' &&                   // major → always notify
      (
        (bump === 'patch' && pack.update_policy === 'auto') ||
        (bump === 'minor' && pack.update_policy === 'auto')
      )

    updates.push({
      pack_id:           pack.pack_id,
      installed_version: pack.version,
      latest_version:    latest.version,
      bump_type:         bump,
      auto_installable:  autoInstallable,
    })
  }

  return updates
}

// ─── Local overrides ──────────────────────────────────────────────────────────

export interface LocalOverride {
  field:    string
  original: string
  override: string
}

/**
 * Apply a local override to an installed pack (Am.67.4).
 * Overrides are stored as a JSON diff — never merged into the base content.
 * On future updates, overrides are re-applied; conflicts are surfaced to the user.
 */
export async function applyLocalOverride(
  userId:    string,
  packId:    string,
  override:  LocalOverride,
): Promise<void> {
  assertPackId(packId)

  const pack = await db.installedPack.findUnique({
    where: { user_id_pack_id: { user_id: userId, pack_id: packId } },
    select: { id: true, local_overrides: true },
  })
  if (!pack) {
    throw new MarketplaceError(`Pack "${packId}" not installed`, 'NOT_INSTALLED')
  }

  const existing = (pack.local_overrides as LocalOverride[] | null) ?? []
  // Replace override for same field, or append
  const updated = [
    ...existing.filter((o) => o.field !== override.field),
    { ...override, created_at: new Date().toISOString() },
  ]

  await db.installedPack.update({
    where: { user_id_pack_id: { user_id: userId, pack_id: packId } },
    data: { local_overrides: updated as never },  // InputJsonValue — array is valid JSON
  })
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * Uninstall a pack for a user.
 * Past runs referencing this pack are unaffected (handoffs are immutable).
 * Returns false if not installed.
 */
export async function uninstallPack(userId: string, packId: string): Promise<boolean> {
  assertPackId(packId)

  const pack = await db.installedPack.findUnique({
    where: { user_id_pack_id: { user_id: userId, pack_id: packId } },
    select: { id: true },
  })
  if (!pack) return false

  await db.installedPack.delete({
    where: { user_id_pack_id: { user_id: userId, pack_id: packId } },
  })

  await db.auditLog.create({
    data: {
      actor:       userId,
      action_type: 'marketplace_uninstall',
      payload:     { pack_id: packId },
    },
  }).catch(() => { /* non-fatal */ })

  return true
}
