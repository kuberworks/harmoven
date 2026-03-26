#!/usr/bin/env node
// scripts/verify-migration-baseline.js
// CI gate — Amendment 88 / T3.5
//
// Blocks the pipeline if any migration directory contains a migration.sql
// without a corresponding down.sql.
//
// Exit codes:
//   0 — all migrations have down.sql
//   1 — one or more migrations are missing down.sql (fails CI)
//
// Usage:
//   node scripts/verify-migration-baseline.js [--migrations-dir <path>]

'use strict'

const fs   = require('node:fs')
const path = require('node:path')

// Allow overriding path for testing
const args      = process.argv.slice(2)
const dirFlagIdx = args.indexOf('--migrations-dir')
const migrDir   = dirFlagIdx !== -1
  ? path.resolve(args[dirFlagIdx + 1])
  : path.resolve(__dirname, '..', 'prisma', 'migrations')

if (!fs.existsSync(migrDir)) {
  console.error(`[migration-check] migrations directory not found: ${migrDir}`)
  process.exit(1)
}

const entries  = fs.readdirSync(migrDir, { withFileTypes: true })
const migDirs  = entries.filter((e) => e.isDirectory()).map((e) => e.name)

const missing = []

for (const dir of migDirs) {
  const fullDir  = path.join(migrDir, dir)
  const upFile   = path.join(fullDir, 'migration.sql')
  const downFile = path.join(fullDir, 'down.sql')

  // Only check directories that have a migration.sql
  if (!fs.existsSync(upFile)) continue

  if (!fs.existsSync(downFile)) {
    missing.push(dir)
  }
}

if (missing.length === 0) {
  console.log(`[migration-check] ✓ All ${migDirs.length} migrations have down.sql`)
  process.exit(0)
} else {
  console.error('[migration-check] ✗ Missing down.sql in the following migrations:')
  for (const m of missing) {
    console.error(`  - prisma/migrations/${m}/down.sql`)
  }
  console.error('')
  console.error('Every migration.sql must have a corresponding down.sql (Amendment 84).')
  console.error('Create a manual rollback script and commit it.')
  process.exit(1)
}
