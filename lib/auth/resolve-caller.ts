// lib/auth/resolve-caller.ts
// Shared helper: resolve a Caller from a Next.js request.
// Used by SSE routes and any other route needing session OR API key auth.
// Uses api-key-validator for timing-safe Bearer token comparison (T3.9 wiring).

import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import type { Caller } from '@/lib/auth/rbac'
import { extractBearerKey, validateApiKey } from '@/lib/auth/api-key-validator'

export async function resolveCaller(req: NextRequest): Promise<Caller | null> {
  try {
    const session = await auth.api.getSession({ headers: req.headers })
    if (session?.user) {
      return {
        type: 'session',
        userId: session.user.id,
        instanceRole: (session.user as { role?: string }).role ?? null,
      }
    }

    // API key auth: expect Authorization: Bearer hv1_...
    // extractBearerKey validates the format; validateApiKey does DB lookup
    // with timingSafeEqual comparison (Amendment 92).
    const rawKey = extractBearerKey(req.headers.get('authorization'))
    if (rawKey) {
      const result = await validateApiKey(rawKey)
      if (result) return { type: 'api_key', keyId: result.id }
    }
  } catch (e) {
    // Unexpected errors (Prisma misconfiguration, network, etc.) are logged so
    // they don't silently masquerade as simple 401s in production.
    // Auth failures (invalid token, expired session) still return null → 401.
    if (process.env.NODE_ENV !== 'test') {
      console.error('[resolveCaller] unexpected error resolving caller:', e)
    }
  }
  return null
}
