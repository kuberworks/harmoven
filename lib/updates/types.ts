// lib/updates/types.ts
// Shared types for the update management system.
// Spec: Amendment 88 (Apple-style update policy, Docker + Electron).

// ─── orchestrator.yaml shape (updates section only) ──────────────────────────

export interface UpdatesConfig {
  auto_check:        boolean          // check for new versions on schedule
  auto_download:     boolean          // download in background silently
  /** notify | auto | manual */
  auto_install:      'notify' | 'auto' | 'manual'
  check_interval_hours: number
  update_channel:    'stable' | 'edge'
  verify_digest:     boolean          // always verify Docker image digest
  cosign_verify:     boolean          // verify Cosign signature if key configured
  cosign_public_key: string | null    // path to public key file
  require_github_release: boolean     // refuse update if no matching GitHub release
}

export const DEFAULT_UPDATES_CONFIG: UpdatesConfig = {
  auto_check:            true,
  auto_download:         true,
  auto_install:          'notify',
  check_interval_hours:  24,
  update_channel:        'stable',
  verify_digest:         true,
  cosign_verify:         false,
  cosign_public_key:     null,
  require_github_release: true,
}

// ─── Version / release info ───────────────────────────────────────────────────

/** Result of a version check against the registry. */
export interface UpdateCheckResult {
  hasUpdate:       boolean
  currentVersion:  string
  latestVersion:   string | null
  /** 'major' | 'minor' | 'patch' — null when no update available */
  bump:            'major' | 'minor' | 'patch' | null
  changelog:       string | null
  imageTag:        string | null
  /** SHA-256 image digest from registry */
  imageDigest:     string | null
  checkedAt:       string       // ISO timestamp
}

/** Verification data for a specific Docker image update. */
export interface UpdateVerification {
  version:      string
  imageTag:     string
  imageDigest:  string
  releaseUrl:   string
  signatureUrl: string
}

// ─── Migration preview ───────────────────────────────────────────────────────

export type MigrationRisk = 'safe' | 'warning' | 'danger'

export interface MigrationStep {
  name:        string         // migration file name, e.g. "20260325171434_init"
  appliedAt:   string | null  // ISO timestamp if already applied; null = pending
  sql:         string         // SQL content (from migration.sql)
  risk:        MigrationRisk
  /** Human-readable reason for the risk level */
  riskReason:  string | null
}

export interface MigrationPreview {
  pending:     MigrationStep[]
  applied:     number          // count of already-applied migrations
  hasDataLoss: boolean         // true if any pending migration has risk 'danger'
}

// ─── Update wizard state ─────────────────────────────────────────────────────

export type UpdateWizardStep =
  | 'idle'
  | 'checking'
  | 'available'
  | 'backup_confirm'
  | 'migration_preview'
  | 'applying'
  | 'health_check'
  | 'done'
  | 'error'
  | 'rolledback'
