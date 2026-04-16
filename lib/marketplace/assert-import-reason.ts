// lib/marketplace/assert-import-reason.ts
// Server-side enforcement of marketplace.import.require_import_reason setting (L6).
//
// Called by:
//   - POST /api/admin/integrations/from-url/approve
//   - POST /api/admin/marketplace/upload
//
// Setting values:
//   'never'           — field hidden; no enforcement
//   'p3_and_overrides' — required for js_ts_plugin imports OR relevance gate overrides
//   'always'          — required for every import
//
// SEC enforcement: NOT client-only — the server always checks regardless of UI state.

import { db } from '@/lib/db/client'

export class ImportReasonRequiredError extends Error {
  readonly status = 422
  constructor() {
    super('An import reason is required for this import type')
    this.name = 'ImportReasonRequiredError'
  }
}

type RequireImportReasonSetting = 'never' | 'p3_and_overrides' | 'always'

async function getSetting(): Promise<RequireImportReasonSetting> {
  const row = await db.systemSetting.findUnique({
    where: { key: 'marketplace.import.require_import_reason' },
  })
  const val = row?.value ?? 'never'
  if (val === 'p3_and_overrides' || val === 'always') return val
  return 'never'
}

/**
 * Assert that an import reason is provided when required by configuration.
 *
 * @param importReason     The free-text reason provided by the admin (may be empty/null)
 * @param capabilityType   The detected capability type of the import
 * @param isGateOverride   True if the admin is overriding a relevance gate warning
 */
export async function assertImportReasonRequired(
  importReason: string | null | undefined,
  capabilityType: string | null | undefined,
  isGateOverride = false,
): Promise<void> {
  const setting = await getSetting()

  if (setting === 'never' && !isGateOverride) return

  const hasReason = typeof importReason === 'string' && importReason.trim().length > 0

  if (setting === 'always' && !hasReason) {
    throw new ImportReasonRequiredError()
  }

  if (setting === 'p3_and_overrides') {
    const needsReason = capabilityType === 'js_ts_plugin' || isGateOverride
    if (needsReason && !hasReason) {
      throw new ImportReasonRequiredError()
    }
  }

  // NOT_RELEVANT gate override always requires reason (cannot be disabled)
  if (isGateOverride && !hasReason) {
    throw new ImportReasonRequiredError()
  }
}
