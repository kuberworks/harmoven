// app/api/admin/marketplace/registries/route.ts
// GET  /api/admin/marketplace/registries  — list (paginated)
// POST /api/admin/marketplace/registries  — add registry
//
// A.3.3 — SEC-08, SEC-11, SEC-14, SEC-15

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { encryptValue } from '@/lib/utils/credential-crypto-ext'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import { revalidatePath } from 'next/cache'

const ListQuerySchema = z.object({
  page:    z.coerce.number().int().min(1).default(1),
  size:    z.coerce.number().int().min(1).max(100).default(20),
  q:       z.string().optional(),
  sort:    z.enum(['label', 'created_at']).default('created_at'),
  order:   z.enum(['asc', 'desc']).default('desc'),
  enabled: z.enum(['true', 'false']).optional(),
})

const CreateSchema = z.object({
  label:       z.string().min(1).max(128),
  feed_url:    z.string().url().max(2048).refine((u) => u.startsWith('https://'), {
    message: 'feed_url must use HTTPS',
  }),
  auth_header: z.string().min(1).max(2048).optional(),
  enabled:     z.boolean().optional().default(true),
})

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  const params = Object.fromEntries(req.nextUrl.searchParams)
  const parsed = ListQuerySchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_PARAMS', details: parsed.error.flatten() }, { status: 400 })
  }
  const { page, size, q, sort, order, enabled } = parsed.data

  const where = {
    ...(q ? {
      OR: [
        { label:    { contains: q, mode: 'insensitive' as const } },
        { feed_url: { contains: q, mode: 'insensitive' as const } },
      ],
    } : {}),
    ...(enabled !== undefined ? { enabled: enabled === 'true' } : {}),
  }

  const orderBy = sort === 'label' ? { label: order } : { created_at: order }

  const [total, rows] = await Promise.all([
    db.marketplaceRegistry.count({ where }),
    db.marketplaceRegistry.findMany({
      where,
      orderBy,
      skip: (page - 1) * size,
      take: size,
      select: {
        id:                true,
        label:             true,
        feed_url:          true,
        is_builtin:        true,
        enabled:           true,
        last_fetched_at:   true,
        last_fetch_status: true,
        created_by:        true,
        created_at:        true,
        updated_at:        true,
        // SEC-14: auth_header_enc never returned — return has_auth flag only
        auth_header_enc:   true,
      },
    }),
  ])

  // Strip encrypted field; expose boolean flag
  const data = rows.map(({ auth_header_enc, ...rest }) => ({
    ...rest,
    has_auth: auth_header_enc !== null && auth_header_enc !== undefined,
  }))

  return NextResponse.json({ data, total, page, size })
}

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const parsed = CreateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 })
  }

  const { label, feed_url, auth_header, enabled } = parsed.data

  // SEC-15: SSRF prevention
  try {
    await assertNotPrivateHost(feed_url)
  } catch {
    return NextResponse.json({ error: 'SSRF_BLOCKED', message: 'feed_url resolves to a private or loopback address.' }, { status: 422 })
  }

  // Check duplicate
  const existing = await db.marketplaceRegistry.findUnique({ where: { feed_url } })
  if (existing) return NextResponse.json({ error: 'DUPLICATE_FEED_URL' }, { status: 409 })

  const auth_header_enc = auth_header ? encryptValue(auth_header) : null

  const registry = await db.marketplaceRegistry.create({
    data: {
      id:             uuidv7(),
      label,
      feed_url,
      auth_header_enc,
      is_builtin:     false,
      enabled,
      created_by:     caller.userId,
    },
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_registry_created',
      payload:     { registry_id: registry.id, feed_url },
    },
  })

  // U14: revalidate browse tab cache
  revalidatePath('/marketplace')

  const { auth_header_enc: _, ...safe } = registry as typeof registry & { auth_header_enc: string | null }
  return NextResponse.json({ ...safe, has_auth: auth_header !== undefined }, { status: 201 })
}
