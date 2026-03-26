// lib/updates/migration-preview.ts
// Reads pending Prisma migrations from the filesystem and assigns risk levels.
// Spec: Amendment 88 — Docker update wizard, migration preview step.
//
// Each migration SQL is analyzed statically to detect potentially destructive
// operations (DROP TABLE, DROP COLUMN, ALTER COLUMN … NOT NULL with no DEFAULT).
// Risk levels:
//   safe    → additive-only changes (CREATE TABLE, CREATE INDEX, ALTER ADD COLUMN)
//   warning → schema changes that could fail on non-empty tables
//   danger  → destructive operations (DROP TABLE, DROP COLUMN, data truncation)
//
// Security:
//   - Reads only from prisma/migrations/ inside process.cwd() — no path traversal
//   - All file reads are synchronous and scoped to the migrations folder

import fs   from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db/client'
import type { MigrationStep, MigrationPreview, MigrationRisk } from './types'

// ─── Risk classification ──────────────────────────────────────────────────────

interface RiskAnalysis {
  risk:       MigrationRisk
  riskReason: string | null
}

/**
 * Classify a migration SQL file by its risk level.
 *
 * We do simple keyword matching on the normalized SQL — accurate enough for
 * the preview use case without pulling in a full SQL parser.
 */
function classifyMigrationRisk(sql: string): RiskAnalysis {
  const upper = sql.toUpperCase()

  // ── DANGER: destructive DDL ───────────────────────────────────────────────
  if (/DROP\s+TABLE\b/.test(upper)) {
    return { risk: 'danger', riskReason: 'Drops a table — existing data will be permanently deleted' }
  }
  if (/DROP\s+COLUMN\b/.test(upper)) {
    return { risk: 'danger', riskReason: 'Drops a column — data in that column will be permanently deleted' }
  }
  if (/TRUNCATE\b/.test(upper)) {
    return { risk: 'danger', riskReason: 'Truncates a table — all rows will be deleted' }
  }
  if (/DELETE\s+FROM\b/.test(upper)) {
    return { risk: 'danger', riskReason: 'Contains a DELETE statement — rows may be deleted' }
  }

  // ── WARNING: schema changes that can fail on non-empty tables ─────────────
  // ALTER COLUMN … NOT NULL without DEFAULT is problematic on populated tables
  if (/ALTER\s+(TABLE|COLUMN)\b/.test(upper) && /NOT\s+NULL\b/.test(upper) && !/DEFAULT\b/.test(upper)) {
    return { risk: 'warning', riskReason: 'Adds a NOT NULL constraint without a DEFAULT value — may fail if the table contains existing rows' }
  }
  if (/ALTER\s+(TABLE|COLUMN)\b/.test(upper)) {
    return { risk: 'warning', riskReason: 'Alters an existing column — verify compatibility with existing data' }
  }
  // Renaming tables/columns is also potentially risky
  if (/RENAME\b/.test(upper)) {
    return { risk: 'warning', riskReason: 'Renames a table or column — any application code referencing the old name will break' }
  }

  // ── SAFE: additive-only changes ───────────────────────────────────────────
  return { risk: 'safe', riskReason: null }
}

// ─── Applied migrations from DB ──────────────────────────────────────────────

interface AppliedMigrationRow {
  migration_name: string
  finished_at:    Date | null
  started_at:     Date | null
}

/**
 * Fetch the set of applied migration names from the Prisma `_prisma_migrations`
 * table. Returns an empty Map if the table doesn't exist (fresh install).
 */
async function fetchAppliedMigrations(): Promise<Map<string, Date | null>> {
  try {
    // Prisma exposes the raw _prisma_migrations table via $queryRaw
    const rows = await db.$queryRaw<AppliedMigrationRow[]>`
      SELECT migration_name, finished_at, started_at
      FROM "_prisma_migrations"
      WHERE rolled_back_at IS NULL
    `
    return new Map(rows.map(r => [r.migration_name, r.finished_at ?? r.started_at]))
  } catch {
    // Table may not exist on a brand-new install — treat all migrations as pending
    return new Map()
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'prisma', 'migrations')

/**
 * Build a migration preview — list all migrations (applied + pending) with
 * risk classification.
 *
 * Used by:
 *   - GET  /api/updates          (full preview in update check result)
 *   - POST /api/updates/apply    (pre-apply safety check)
 */
export async function generateMigrationPreview(): Promise<MigrationPreview> {
  const applied = await fetchAppliedMigrations()

  // Enumerate migration folders — sorted lexicographically (timestamp prefix)
  let migrationDirs: string[] = []
  try {
    migrationDirs = fs.readdirSync(MIGRATIONS_DIR)
      .filter(entry => {
        const full = path.join(MIGRATIONS_DIR, entry)
        return fs.statSync(full).isDirectory()
      })
      .sort() // lexicographic = chronological due to timestamp prefix
  } catch {
    // prisma/migrations doesn't exist yet
    return { pending: [], applied: applied.size, hasDataLoss: false }
  }

  const steps: MigrationStep[] = []

  for (const dirName of migrationDirs) {
    const sqlPath = path.join(MIGRATIONS_DIR, dirName, 'migration.sql')
    let sql = ''
    try {
      sql = fs.readFileSync(sqlPath, 'utf8')
    } catch {
      // No migration.sql (e.g. migration_lock.toml directory) — skip silently
      continue
    }

    const isApplied = applied.has(dirName)
    const appliedAt = isApplied ? (applied.get(dirName)?.toISOString() ?? null) : null
    const { risk, riskReason } = classifyMigrationRisk(sql)

    steps.push({
      name:       dirName,
      appliedAt,
      sql,
      risk,
      riskReason,
    })
  }

  const pending     = steps.filter(s => s.appliedAt === null)
  const appliedCount = steps.filter(s => s.appliedAt !== null).length
  const hasDataLoss  = pending.some(s => s.risk === 'danger')

  return {
    pending,
    applied:     appliedCount,
    hasDataLoss,
  }
}
