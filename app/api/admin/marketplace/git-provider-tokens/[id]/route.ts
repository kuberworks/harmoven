// app/api/admin/marketplace/git-provider-tokens/[id]/route.ts
// PATCH  /api/admin/marketplace/git-provider-tokens/:id  — update
// DELETE /api/admin/marketplace/git-provider-tokens/:id  — delete
//
// A.5.3 — SEC-46

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { encryptValue } from '@/lib/utils/credential-crypto-ext'

const PatchSchema = z.object({
  label:        z.string().min(1).max(128).optional(),
  host_pattern: z.string().min(1).max(253).optional(),
  token:        z.string().min(1).max(2048).optional(),
  enabled:      z.boolean().optional(),
  expires_at:   z.string().datetime().nullable().optional(),
})

function expiryStatus(expiresAt: Date | null | undefined): 'valid' | 'expiring_soon' | 'expired' {
  if (!expiresAt) return 'valid'
  const now = Date.now()
  const exp = expiresAt.getTime()
  if (exp < now) return 'expired'
  if (exp - now < 30 * 24 * 60 * 60 * 1000) return 'expiring_soon'
  return 'valid'
}

type RouteParams = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)
  const { id } = await params

  const tok = await db.gitProviderToken.findUnique({ where: { id } })
  if (!tok) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 })
  }

  const { label, host_pattern, token, enabled, expires_at } = parsed.data

  // A.5.4: new host_pattern must be whitelisted
  if (host_pattern !== undefined && host_pattern !== tok.host_pattern) {
    const entries = await db.gitUrlWhitelistEntry.findMany({
      where: { enabled: true }, select: { pattern: true },
    })
    const { default: micromatch } = await import('micromatch')
    const isWhitelisted = entries.some((e) => micromatch.isMatch(host_pattern, e.pattern))
    if (!isWhitelisted) {
      return NextResponse.json({ error: 'HOST_NOT_WHITELISTED' }, { status: 422 })
    }
    // Check uniqueness
    const dupe = await db.gitProviderToken.findUnique({ where: { host_pattern } })
    if (dupe) return NextResponse.json({ error: 'DUPLICATE_HOST_PATTERN' }, { status: 409 })
  }

  const token_enc = token !== undefined ? encryptValue(token) : undefined

  const updated = await db.gitProviderToken.update({
    where: { id },
    data: {
      ...(label        !== undefined ? { label }        : {}),
      ...(host_pattern !== undefined ? { host_pattern } : {}),
      ...(token_enc    !== undefined ? { token_enc }    : {}),
      ...(enabled      !== undefined ? { enabled }      : {}),
      ...(expires_at   !== undefined ? { expires_at: expires_at === null ? null : new Date(expires_at) } : {}),
    },
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_git_token_updated',
      payload:     { token_id: id, changes: { label, host_pattern, enabled, token_changed: token !== undefined } },
    },
  })

  const { token_enc: _, ...safe } = updated as typeof updated & { token_enc: string }
  return NextResponse.json({
    ...safe,
    has_token:     true,
    expiry_status: expiryStatus(updated.expires_at),
  })
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)
  const { id } = await params

  const tok = await db.gitProviderToken.findUnique({ where: { id } })
  if (!tok) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  await db.gitProviderToken.delete({ where: { id } })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_git_token_deleted',
      payload:     { token_id: id, host_pattern: tok.host_pattern },
    },
  })

  return new NextResponse(null, { status: 204 })
}
