// lib/auth/rate-limit-config.ts
// DB-backed rate limit configuration, readable and writable by instance_admin
// via GET/PATCH /api/admin/rate-limits.
//
// Priority:
//   1. SystemSetting rows (set by instance_admin at runtime)
//   2. Hardcoded defaults (Stripe-level conservative defaults)
//
// The config is cached in-process for CACHE_TTL_MS (60 s) to avoid a DB round-
// trip on every request while still reflecting admin changes within a minute.
//
// Keys stored in SystemSetting:
//   rate_limit.<endpoint>.max        → integer string  (e.g. "10")
//   rate_limit.<endpoint>.window_ms  → integer string  (e.g. "900000")

import { db } from '@/lib/db/client'

// ─── Endpoint registry ───────────────────────────────────────────────────────

/**
 * All configurable rate-limit endpoints.
 * Default values are Stripe / industry-conservative baselines.
 */
export const RATE_LIMIT_DEFAULTS = {
  /** Auth sign-in: 10 attempts per 15 minutes. */
  'signin':           { max: 10,  window_ms: 15 * 60 * 1000 },
  /** POST /api/runs and /api/v1/runs: 60 requests per minute. */
  'create-run':       { max: 60,  window_ms:      60 * 1000 },
  /** POST /api/projects/:id/api-keys: 10 per 15 minutes. */
  'create-api-key':   { max: 10,  window_ms: 15 * 60 * 1000 },
  /** POST /api/webhooks/:projectId/:triggerId: 120 per minute per trigger. */
  'webhook':          { max: 120, window_ms:      60 * 1000 },
  /** POST /api/admin/credentials: 20 per hour. */
  'admin-cred-create':{ max: 20,  window_ms: 60 * 60 * 1000 },
} as const satisfies Record<string, { max: number; window_ms: number }>

export type RateLimitEndpoint = keyof typeof RATE_LIMIT_DEFAULTS

export interface RateLimitEntry {
  max:               number
  window_ms:         number
  default_max:       number
  default_window_ms: number
}

export type RateLimitMap = Record<RateLimitEndpoint, RateLimitEntry>

// ─── In-process cache ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 1000  // 60 seconds

interface CacheEntry {
  value:     RateLimitMap
  expiresAt: number
}

let _cache: CacheEntry | null = null

function buildKeys(): string[] {
  const keys: string[] = []
  for (const endpoint of Object.keys(RATE_LIMIT_DEFAULTS) as RateLimitEndpoint[]) {
    keys.push(`rate_limit.${endpoint}.max`)
    keys.push(`rate_limit.${endpoint}.window_ms`)
  }
  return keys
}

/** Read all rate-limit settings from DB and apply defaults. */
async function loadFromDB(): Promise<RateLimitMap> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: buildKeys() } },
    select: { key: true, value: true },
  })
  const map = new Map(rows.map(r => [r.key, r.value]))

  const result = {} as RateLimitMap
  for (const [endpoint, defaults] of Object.entries(RATE_LIMIT_DEFAULTS) as [RateLimitEndpoint, { max: number; window_ms: number }][]) {
    const maxRaw      = map.get(`rate_limit.${endpoint}.max`)
    const windowRaw   = map.get(`rate_limit.${endpoint}.window_ms`)
    const parsedMax   = maxRaw    ? parseInt(maxRaw, 10)    : NaN
    const parsedWin   = windowRaw ? parseInt(windowRaw, 10) : NaN
    result[endpoint] = {
      max:               isFinite(parsedMax) && parsedMax >= 1 ? parsedMax : defaults.max,
      window_ms:         isFinite(parsedWin) && parsedWin >= 1000 ? parsedWin : defaults.window_ms,
      default_max:       defaults.max,
      default_window_ms: defaults.window_ms,
    }
  }
  return result
}

/** Invalidate the in-process cache immediately (call after PATCH). */
export function invalidateRateLimitCache(): void {
  _cache = null
}

/** Return a fresh or cached RateLimitMap. */
async function getAll(): Promise<RateLimitMap> {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.value
  const value = await loadFromDB()
  _cache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
  return value
}

/**
 * Get the effective (max, window_ms) for a given rate-limit endpoint.
 *
 * Falls back to the hardcoded defaults if the DB is unavailable or
 * the setting has not been configured yet.
 *
 * @param endpoint  One of the keys in RATE_LIMIT_DEFAULTS.
 */
export async function getRateLimitConfig(
  endpoint: RateLimitEndpoint,
): Promise<{ max: number; window_ms: number }> {
  try {
    const all = await getAll()
    return { max: all[endpoint].max, window_ms: all[endpoint].window_ms }
  } catch {
    // DB unavailable — use safe defaults (never block the request due to a DB error)
    const d = RATE_LIMIT_DEFAULTS[endpoint]
    return { max: d.max, window_ms: d.window_ms }
  }
}

/** Return the full map (used by the admin API). */
export async function getAllRateLimitConfigs(): Promise<RateLimitMap> {
  return getAll()
}
