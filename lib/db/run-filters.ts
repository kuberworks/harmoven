// lib/db/run-filters.ts
// Shared Prisma where-clause fragments for Run queries.
//
// SEC-21: Phantom runs (run_type = 'marketplace_import') must be excluded from
// all normal run list / count queries. They exist only for cost accounting and
// must never appear in user-facing run lists, analytics, or data exports.
//
// Usage:
//   import { EXCLUDE_PHANTOM_RUNS } from '@/lib/db/run-filters'
//   db.run.findMany({ where: { ...EXCLUDE_PHANTOM_RUNS, ...otherFilters } })

import type { Prisma } from '@prisma/client'

/**
 * Add this fragment to every `db.run.findMany` / `db.run.count` where-clause
 * that is NOT specifically querying for marketplace import cost accounting.
 */
export const EXCLUDE_PHANTOM_RUNS = {
  NOT: { run_type: 'marketplace_import' },
} satisfies Prisma.RunWhereInput
