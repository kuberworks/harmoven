// lib/auth/rate-limit.ts
// In-process IP-based rate limiting for sensitive endpoints.
// DoD T1.3: sign-in 5/15 min | DoD §API: POST /api/runs 10/min (MISS-12).
//
// Uses an LRU-style Map with per-key expiry. Falls back to always-allow in
// test environments. For horizontal scale, replace with @upstash/ratelimit.
//
// SECURITY: IP is read from X-Forwarded-For (trusted CDN/reverse-proxy setup)
// with a fallback. Do NOT expose this directly without a trusted proxy.

import type { NextRequest, NextResponse } from 'next/server'
import { NextResponse as Response } from 'next/server'

interface RateLimitEntry {
  count:     number
  resetAt:   number  // epoch ms
}

const _buckets = new Map<string, RateLimitEntry>()

/** Extract IP from the request (X-Forwarded-For or fallback). */
function getIP(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  // ip() is not available in all Next.js versions — fallback to empty string
  return first ?? 'unknown'
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
