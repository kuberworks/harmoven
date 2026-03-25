// lib/auth/resolve-caller.ts
// Shared helper: resolve a Caller from a Next.js request.
// Used by SSE routes and any other route needing session OR API key auth.
// Centralises crypto import (no require('crypto') in modules).

import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import type { Caller } from '@/lib/auth/rbac'

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
    const bearer = req.headers.get('authorization')?.replace('Bearer ', '')
    if (bearer) {
      const keyHash = createHash('sha256').update(bearer).digest('hex')
      const key = await db.projectApiKey.findFirst({
        where: { key_hash: keyHash, revoked_at: null },
        select: { id: true },
      })
      if (key) return { type: 'api_key', keyId: key.id }
    }
  } catch {
    // Auth errors → caller unresolved → route returns 401
  }
  return null
}
