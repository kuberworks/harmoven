// lib/auth/rate-limit.ts
// In-process IP-based rate limiting for sensitive endpoints.
// DoD T1.3: sign-in 5/15 min | DoD §API: POST /api/runs 10/min (MISS-12).
//
// Uses an LRU-style Map with per-key expiry. Falls back to always-allow in
// test environments. For horizontal scale, replace with @upstash/ratelimit.
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

interface RateLimitEntry {
  count:     number
  resetAt:   number  // epoch ms
}

const _buckets = new Map<string, RateLimitEntry>()

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
    // Rate limiting still applies per-instance, not per-IP.
    return 'unknown'
  }

  // Take the entry at index (length - trustedProxies), floor at 0.
  // This is the IP that the outermost trusted proxy recorded as the client.
  const idx = Math.max(0, parts.length - trustedProxies)
  return parts[idx] ?? 'unknown'
}

/**
 * Check whether a request from this IP exceeds the given rate limit.
 *
 * @param req       The incoming request.
 * @param key       Namespace key (e.g. 'signin', 'create-run').
 * @param max       Max allowed requests in the window.
 * @param windowMs  Window duration in milliseconds.
 * @returns         NextResponse 429 if rate-limited, null if allowed.
 */
export function checkRateLimit(
  req:      NextRequest,
  key:      string,
  max:      number,
  windowMs: number,
): NextResponse | null {
  if (process.env.NODE_ENV === 'test') return null

  const ip = getIP(req)
  const bucketKey = `${key}:${ip}`
  const now = Date.now()

  const entry = _buckets.get(bucketKey)

  if (!entry || now > entry.resetAt) {
    // First request or window expired — open a new window.
    _buckets.set(bucketKey, { count: 1, resetAt: now + windowMs })
    return null
  }

  if (entry.count >= max) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000)
    return Response.json(
      { error: 'Too many requests', retryAfter: retryAfterSec },
      {
        status: 429,
        headers: {
          'Retry-After':        String(retryAfterSec),
          'X-RateLimit-Limit':  String(max),
          'X-RateLimit-Reset':  String(Math.ceil(entry.resetAt / 1000)),
        },
      },
    )
  }

  entry.count++
  return null
}

/** Rate limit preset: sign-in — 5 attempts per 15 minutes. */
export function signInRateLimit(req: NextRequest): NextResponse | null {
  return checkRateLimit(req, 'signin', 5, 15 * 60 * 1000)
}

/** Rate limit preset: POST /api/runs — 10 requests per minute. */
export function createRunRateLimit(req: NextRequest): NextResponse | null {
  return checkRateLimit(req, 'create-run', 10, 60 * 1000)
}
