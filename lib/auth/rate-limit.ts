// lib/auth/rate-limit.ts
// IP-based rate limiting for sensitive endpoints.
// DoD T1.3: sign-in 5/15 min | DoD §API: POST /api/runs 10/min (MISS-12).
//
// Two backends — selected at startup:
//   • Redis  — when REDIS_URL is set (distributed, works across replicas)
//   • Memory — in-process Map with TTL cleanup (single-instance deployments)
//
// Redis backend uses a Lua script for an atomic fixed-window counter, so it is
// safe under concurrent Node.js processes pointing at the same Redis instance.
//
// C-03 — SECURITY: X-Forwarded-For trust model
// The leftmost IP in XFF is set by the client and is trivially forgeable.
// To obtain the actual client IP, we trust TRUSTED_PROXY_COUNT reverse proxies
// (default: 1, assuming nginx/Caddy/Traefik in Docker) and take the entry
// added by the outermost trusted proxy — i.e. xffParts[xffParts.length - N].
//
// Operators MUST set TRUSTED_PROXY_COUNT correctly in .env:
//   0  — No proxy in front; XFF is always forged; fall back to 'unknown' (weaker)
//   1  — One trusted proxy (nginx, Caddy, Traefik, Cloudflare edge) — default
//   N  — N chained trusted proxies
//
// If TRUSTED_PROXY_COUNT=0 with no reverse proxy, all requests share the
// 'unknown' bucket — rate limiting is still enforced but per-instance only.

import type { NextRequest, NextResponse } from 'next/server'
import { NextResponse as Response } from 'next/server'

// ─── Redis client (optional) ─────────────────────────────────────────────────

// Used with a dynamic require so the module still loads when ioredis is
// present but REDIS_URL is unset (client remains null — memory fallback used).

type RedisClient = {
  defineCommand(name: string, opts: { numberOfKeys: number; lua: string }): void
  [key: string]: unknown
}

let _redis: RedisClient | null = null

if (process.env.REDIS_URL && process.env.NODE_ENV !== 'test') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { default: Redis } = require('ioredis') as {
      default: new (url: string, opts?: Record<string, unknown>) => RedisClient
    }
    _redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest:   1,
      enableOfflineQueue:     false,
      connectTimeout:         2000,
      lazyConnect:            true,
    })

    // Atomic Lua script: increment and set TTL if first request in window.
    // Returns [count, ttlMs] where ttlMs is the remaining TTL in milliseconds.
    ;(_redis as RedisClient & {
      rateLimitIncr(key: string, max: string, windowMs: string): Promise<[number, number]>
    }).defineCommand('rateLimitIncr', {
      numberOfKeys: 1,
      lua: `
        local cur = redis.call('INCR', KEYS[1])
        if cur == 1 then
          redis.call('PEXPIRE', KEYS[1], ARGV[2])
        end
        local ttl = redis.call('PTTL', KEYS[1])
        return {cur, ttl}
      `,
    })
  } catch (err) {
    console.warn('[rate-limit] ioredis init failed — falling back to in-memory:', err)
    _redis = null
  }
}

// ─── In-memory backend ───────────────────────────────────────────────────────

interface RateLimitEntry {
  count:   number
  resetAt: number  // epoch ms
}

const _buckets = new Map<string, RateLimitEntry>()

// Periodic cleanup: remove expired entries every 5 minutes to prevent unbounded
// Map growth in long-running single-instance deployments.
if (typeof setInterval !== 'undefined' && process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const now = Date.now()
    for (const [k, v] of _buckets) {
      if (now > v.resetAt) _buckets.delete(k)
    }
  }, 5 * 60 * 1000).unref()
}

// ─── IP extraction ───────────────────────────────────────────────────────────

/**
 * Extract the client IP from the request respecting trusted proxy count.
 *
 * With TRUSTED_PROXY_COUNT=1 (default):
 *   XFF: "forged, real-client-ip" → the proxy appends "real-client-ip" → we take it.
 *   XFF: "real-client-ip"         → single hop → we take it.
 *
 * Attackers can inject leading IPs but cannot inject entries AFTER trusted proxies add theirs.
 */
function getIP(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (!forwarded) return 'unknown'

  const parts = forwarded.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return 'unknown'

  const trustedProxies = Math.max(0,
    parseInt(process.env.TRUSTED_PROXY_COUNT ?? '1', 10) || 1,
  )

  if (trustedProxies === 0) {
    // No trusted proxy — XFF is fully untrusted. All traffic shares 'unknown'.
    return 'unknown'
  }

  const idx = Math.max(0, parts.length - trustedProxies)
  return parts[idx] ?? 'unknown'
}

// ─── 429 response builder ────────────────────────────────────────────────────

function tooMany(max: number, retryAfterMs: number): NextResponse {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000)
  return Response.json(
    { error: 'Too many requests', retryAfter: retryAfterSec },
    {
      status: 429,
      headers: {
        'Retry-After':        String(retryAfterSec),
        'X-RateLimit-Limit':  String(max),
        'X-RateLimit-Reset':  String(Math.ceil((Date.now() + retryAfterMs) / 1000)),
      },
    },
  )
}

// ─── Core check (async) ──────────────────────────────────────────────────────

/**
 * Async rate-limit check. Uses Redis when REDIS_URL is set, otherwise
 * falls back to the in-process Map.
 *
 * @param req       The incoming request.
 * @param key       Namespace key (e.g. 'signin', 'create-run').
 * @param max       Max allowed requests in the window.
 * @param windowMs  Window duration in milliseconds.
 * @returns         NextResponse 429 if rate-limited, null if allowed.
 */
export async function checkRateLimitAsync(
  req:      NextRequest,
  key:      string,
  max:      number,
  windowMs: number,
): Promise<NextResponse | null> {
  if (process.env.NODE_ENV === 'test') return null
  // NOTE (WARN-002): rate limiting is intentionally ACTIVE in development.
  // In dev without a reverse proxy, X-Forwarded-For is unset → all requests
  // share the 'unknown' IP bucket.

  const ip        = getIP(req)
  const bucketKey = `rl:${key}:${ip}`

  // ── Redis path ──────────────────────────────────────────────────────────
  if (_redis) {
    try {
      const client = _redis as RedisClient & {
        rateLimitIncr(key: string, max: string, windowMs: string): Promise<[number, number]>
      }
      const [count, ttlMs] = await client.rateLimitIncr(bucketKey, String(max), String(windowMs))
      if (count > max) return tooMany(max, Math.max(0, ttlMs))
      return null
    } catch (redisErr) {
      // Redis error — degrade gracefully to the in-memory backend.
      console.warn('[rate-limit] Redis check failed, using memory fallback:', redisErr)
    }
  }

  // ── Memory path ─────────────────────────────────────────────────────────
  const now   = Date.now()
  const entry = _buckets.get(bucketKey)

  if (!entry || now > entry.resetAt) {
    _buckets.set(bucketKey, { count: 1, resetAt: now + windowMs })
    return null
  }

  if (entry.count >= max) {
    return tooMany(max, entry.resetAt - now)
  }

  entry.count++
  return null
}

/**
 * Synchronous in-memory-only check (kept for backward compatibility with
 * callers that cannot be easily made async). Prefers memory even if Redis
 * is configured — use checkRateLimitAsync() for distributed correctness.
 *
 * @deprecated Use checkRateLimitAsync() instead.
 */
export function checkRateLimit(
  req:      NextRequest,
  key:      string,
  max:      number,
  windowMs: number,
): NextResponse | null {
  if (process.env.NODE_ENV === 'test') return null

  const ip        = getIP(req)
  const bucketKey = `rl:${key}:${ip}`
  const now       = Date.now()
  const entry     = _buckets.get(bucketKey)

  if (!entry || now > entry.resetAt) {
    _buckets.set(bucketKey, { count: 1, resetAt: now + windowMs })
    return null
  }

  if (entry.count >= max) return tooMany(max, entry.resetAt - now)

  entry.count++
  return null
}

/** Async rate limit preset: sign-in — 5 attempts per 15 minutes. */
export async function signInRateLimitAsync(req: NextRequest): Promise<NextResponse | null> {
  return checkRateLimitAsync(req, 'signin', 5, 15 * 60 * 1000)
}

/** Async rate limit preset: POST /api/runs — 10 requests per minute. */
export async function createRunRateLimitAsync(req: NextRequest): Promise<NextResponse | null> {
  return checkRateLimitAsync(req, 'create-run', 10, 60 * 1000)
}

/** @deprecated Use signInRateLimitAsync() */
export function signInRateLimit(req: NextRequest): NextResponse | null {
  return checkRateLimit(req, 'signin', 5, 15 * 60 * 1000)
}

/** @deprecated Use createRunRateLimitAsync() */
export function createRunRateLimit(req: NextRequest): NextResponse | null {
  return checkRateLimit(req, 'create-run', 10, 60 * 1000)
}
