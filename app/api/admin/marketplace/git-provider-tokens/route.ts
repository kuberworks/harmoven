// app/api/admin/marketplace/git-provider-tokens/route.ts
// GET  /api/admin/marketplace/git-provider-tokens  — list
// POST /api/admin/marketplace/git-provider-tokens  — create
//
// A.5.3 — SEC-46, SEC-47

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { encryptValue } from '@/lib/utils/credential-crypto-ext'

const ListQuerySchema = z.object({
  page:    z.coerce.number().int().min(1).default(1),
  size:    z.coerce.number().int().min(1).max(100).default(20),
  q:       z.string().optional(),
  sort:    z.enum(['label', 'created_at']).default('created_at'),
  order:   z.enum(['asc', 'desc']).default('desc'),
})

const CreateSchema = z.object({
  label:        z.string().min(1).max(128),
  host_pattern: z.string().min(1).max(253),
  token:        z.string().min(1).max(2048),
  enabled:      z.boolean().optional().default(true),
  expires_at:   z.string().datetime().optional(),
})

/** Compute expiry_status from optional expires_at date */
function expiryStatus(expiresAt: Date | null | undefined): 'valid' | 'expiring_soon' | 'expired' {
  if (!expiresAt) return 'valid'
  const now = Date.now()
  const exp = expiresAt.getTime()
  if (exp < now) return 'expired'
  if (exp - now < 30 * 24 * 60 * 60 * 1000) return 'expiring_soon'
  return 'valid'
}

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)

  const params = Object.fromEntries(req.nextUrl.searchParams)
  const parsed = ListQuerySchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_PARAMS', details: parsed.error.flatten() }, { status: 400 })
  }
  const { page, size, q, sort, order } = parsed.data

  const where = q ? {
    OR: [
      { label:        { contains: q, mode: 'insensitive' as const } },
      { host_pattern: { contains: q, mode: 'insensitive' as const } },
    ],
  } : {}

  const orderBy = sort === 'label' ? { label: order } : { created_at: order }

  const [total, rows] = await Promise.all([
    db.gitProviderToken.count({ where }),
    db.gitProviderToken.findMany({
      where,
      orderBy,
      skip: (page - 1) * size,
      take: size,
      select: {
        id:           true,
        label:        true,
        host_pattern: true,
        enabled:      true,
        expires_at:   true,
        created_by:   true,
        created_at:   true,
        updated_at:   true,
        token_enc:    true,  // needed to compute has_token
      },
    }),
  ])

  // SEC-46: never return raw token — has_token boolean only
  const data = rows.map(({ token_enc, expires_at, ...rest }) => ({
    ...rest,
    has_token:     token_enc !== null && token_enc !== '',
    expires_at:    expires_at ?? null,
    expiry_status: expiryStatus(expires_at),
  }))

  return NextResponse.json({ data, total, page, size })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 })
  }

  const { label, host_pattern, token, enabled, expires_at } = parsed.data

  // A.5.4: host_pattern must match an existing GitUrlWhitelistEntry
  const entries = await db.gitUrlWhitelistEntry.findMany({
    where: { enabled: true },
    select: { pattern: true },
  })
  const { default: micromatch } = await import('micromatch')
  const isWhitelisted = entries.some((e) => micromatch.isMatch(host_pattern, e.pattern))
  if (!isWhitelisted) {
    return NextResponse.json({
      error: 'HOST_NOT_WHITELISTED',
      message: 'The host_pattern must match an existing enabled Git URL whitelist entry.',
    }, { status: 422 })
  }

  // Check uniqueness
  const existing = await db.gitProviderToken.findUnique({ where: { host_pattern } })
  if (existing) return NextResponse.json({ error: 'DUPLICATE_HOST_PATTERN' }, { status: 409 })

  const token_enc = encryptValue(token)

  const record = await db.gitProviderToken.create({
    data: {
      id:           uuidv7(),
      label,
      host_pattern,
      token_enc,
      enabled,
      expires_at:   expires_at ? new Date(expires_at) : null,
      created_by:   caller.userId,
    },
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_git_token_created',
      payload:     { token_id: record.id, host_pattern },
    },
  })

  const { token_enc: _, ...safe } = record as typeof record & { token_enc: string }
  return NextResponse.json({
    ...safe,
    has_token:     true,
    expiry_status: expiryStatus(record.expires_at),
  }, { status: 201 })
}
