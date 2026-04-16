// lib/maintenance/rgpd-config.ts
// Runtime RGPD configuration — readable by instance_admin via /api/admin/rgpd.
//
// Priority order (highest to lowest):
//   1. SystemSetting rows in DB (set by instance_admin at runtime)
//   2. Env vars RGPD_MAINTENANCE_ENABLED / DATA_RETENTION_DAYS (deploy-time override)
//   3. Hardcoded safe defaults (maintenance ON, retention 90 days)
//
// The env var layer is an operator escape hatch: if RGPD_MAINTENANCE_ENABLED=false
// is set, the crons stay off regardless of what the admin sets in the UI.
// This is surfaced as `env_override_active: true` in the GET response.
//
// Keys used in SystemSetting:
//   'rgpd.maintenance_enabled'   → bool  (default: true)
//   'rgpd.data_retention_days'   → int   (default: 90)

import { db } from '@/lib/db/client'

export const RGPD_KEYS = {
  maintenanceEnabled: 'rgpd.maintenance_enabled',
  dataRetentionDays:  'rgpd.data_retention_days',
} as const

export interface RgpdConfig {
  /** Whether the automated purge crons run (session cleanup + run data TTL). */
  maintenance_enabled:  boolean
  /** After how many days Run content fields are nullified by the TTL cron. */
  data_retention_days:  number
  /** True when the env var RGPD_MAINTENANCE_ENABLED=false overrides the DB setting. */
  env_override_active: boolean
}

const ENV_OVERRIDE_ACTIVE =
  process.env.RGPD_MAINTENANCE_ENABLED === 'false'

/** Read live RGPD config from DB (no cache — cheap query, must reflect admin changes immediately). */
export async function getRgpdConfig(): Promise<RgpdConfig> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: Object.values(RGPD_KEYS) } },
  })

  const map = new Map(rows.map(r => [r.key, r.value]))

  const db_maintenance_enabled =
    map.has(RGPD_KEYS.maintenanceEnabled)
      ? map.get(RGPD_KEYS.maintenanceEnabled) === 'true'
      : true   // default ON

  const db_data_retention_days =
    map.has(RGPD_KEYS.dataRetentionDays)
      ? parseInt(map.get(RGPD_KEYS.dataRetentionDays)!, 10)
      : parseInt(process.env.DATA_RETENTION_DAYS ?? '90', 10)

  // Env var wins over DB when set to false (operator escape hatch)
  const maintenance_enabled = ENV_OVERRIDE_ACTIVE ? false : db_maintenance_enabled

  return {
    maintenance_enabled,
    data_retention_days: isNaN(db_data_retention_days) ? 90 : db_data_retention_days,
    env_override_active: ENV_OVERRIDE_ACTIVE,
  }
}
