#!/usr/bin/env node
// scripts/verify-migration-baseline.js
//
// Verifies that the database schema is in a clean "baseline" state after
// all down.sql migrations have been applied (used by migration-roundtrip CI job).
//
// When DATABASE_URL is not set (e.g. migration-check job in CI), the script
// verifies that every migration directory has a non-empty down.sql and exits 0.
// When DATABASE_URL is set, it connects to Postgres and asserts that no
// user-created tables remain.

'use strict'

const fs   = require('fs')
const path = require('path')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations')

// ── Case 1: no DB → structural check only ─────────────────────────────────────
if (!process.env.DATABASE_URL) {
  const dirs = fs.readdirSync(MIGRATIONS_DIR).filter(d =>
    fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql'))
  )

  let allOk = true
  for (const dir of dirs) {
    const downPath = path.join(MIGRATIONS_DIR, dir, 'down.sql')
    if (!fs.existsSync(downPath)) {
      console.error(`[baseline-verifier] MISSING down.sql: ${dir}`)
      allOk = false
      continue
    }
    const content = fs.readFileSync(downPath, 'utf8').trim()
    if (!content || content.replace(/--[^\n]*/g, '').trim() === '') {
      console.error(`[baseline-verifier] EMPTY down.sql: ${dir}`)
      allOk = false
    }
  }

  if (!allOk) {
    console.error('[baseline-verifier] Some migrations are missing or have empty down.sql files.')
    process.exit(1)
  }

  console.log(`[baseline-verifier] OK — ${dirs.length} migration(s) all have non-empty down.sql (structural check; no DATABASE_URL).`)
  process.exit(0)
}

// ── Case 2: DB available → verify schema is empty ─────────────────────────────
const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    // List all tables in the public schema, excluding Prisma's own migration table.
    const { rows } = await client.query(`
      SELECT tablename
      FROM   pg_tables
      WHERE  schemaname = 'public'
        AND  tablename  != '_prisma_migrations'
      ORDER  BY tablename
    `)

    if (rows.length > 0) {
      const tables = rows.map(r => r.tablename).join(', ')
      console.error(`[baseline-verifier] FAIL — ${rows.length} table(s) still present after full rollback: ${tables}`)
      process.exit(1)
    }

    // Also check no user-defined enums remain.
    const { rows: enumRows } = await client.query(`
      SELECT typname
      FROM   pg_type
      WHERE  typtype = 'e'
        AND  typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      ORDER  BY typname
    `)

    if (enumRows.length > 0) {
      const enums = enumRows.map(r => r.typname).join(', ')
      console.error(`[baseline-verifier] FAIL — ${enumRows.length} enum(s) still present after full rollback: ${enums}`)
      process.exit(1)
    }

    console.log('[baseline-verifier] OK — schema is clean after full rollback.')
    process.exit(0)
  } finally {
    await client.end()
  }
}

main().catch(err => {
  console.error('[baseline-verifier] Unexpected error:', err.message)
  process.exit(1)
})
