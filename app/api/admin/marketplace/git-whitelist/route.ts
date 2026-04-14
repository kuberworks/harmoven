// app/api/admin/marketplace/git-whitelist/route.ts
// GET  /api/admin/marketplace/git-whitelist  — list (paginated, searchable)
// POST /api/admin/marketplace/git-whitelist  — create entry
//
// A.2.2 — SEC-01, SEC-08, SEC-11

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'

// ─── Validation helpers (A.2.3) ──────────────────────────────────────────────

const PRIVATE_PREFIXES = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d+)?$/, // bare IPs + CIDR
]

function isValidHostnamePattern(pattern: string): boolean {
  if (!pattern || pattern.length > 253) return false
  for (const re of PRIVATE_PREFIXES) {
    if (re.test(pattern)) return false
  }
  // Allow hostname globs like *.example.com — no spaces, no slashes
  const sanitized = pattern.replace(/^\*\./, '')
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(sanitized) || /^[a-z0-9]+$/i.test(sanitized)
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateSchema = z.object({
  label:       z.string().min(1).max(128),
  pattern:     z.string().min(1).max(253),
  description: z.string().max(512).optional(),
  enabled:     z.boolean().optional().default(true),
})

const ListQuerySchema = z.object({
  page:    z.coerce.number().int().min(1).default(1),
  size:    z.coerce.number().int().min(1).max(100).default(20),
  q:       z.string().optional(),
  sort:    z.enum(['label', 'pattern', 'created_at']).default('created_at'),
  order:   z.enum(['asc', 'desc']).default('desc'),
  enabled: z.enum(['true', 'false']).optional(),
})

// ─── GET handler ─────────────────────────────────────────────────────────────

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
        { label:   { contains: q, mode: 'insensitive' as const } },
        { pattern: { contains: q, mode: 'insensitive' as const } },
      ],
    } : {}),
    ...(enabled !== undefined ? { enabled: enabled === 'true' } : {}),
  }

  const orderBy = sort === 'created_at'
    ? { created_at: order }
    : sort === 'label'
    ? { label: order }
    : { pattern: order }

  const [total, entries] = await Promise.all([
    db.gitUrlWhitelistEntry.count({ where }),
    db.gitUrlWhitelistEntry.findMany({
      where,
      orderBy,
      skip: (page - 1) * size,
      take: size,
    }),
  ])

  return NextResponse.json({ data: entries, total, page, size })
}

// ─── POST handler ─────────────────────────────────────────────────────────────

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

  const { label, pattern, description, enabled } = parsed.data

  if (!isValidHostnamePattern(pattern)) {
    return NextResponse.json({ error: 'INVALID_PATTERN', message: 'Pattern must be a valid hostname or glob (*.example.com). Bare IPs, CIDR, localhost, and private ranges are not allowed.' }, { status: 422 })
  }

  // Check for duplicates
  const existing = await db.gitUrlWhitelistEntry.findUnique({ where: { pattern } })
  if (existing) {
    return NextResponse.json({ error: 'DUPLICATE_PATTERN' }, { status: 409 })
  }

  const entry = await db.gitUrlWhitelistEntry.create({
    data: {
      id:         uuidv7(),
      label,
      pattern,
      description: description ?? null,
      enabled,
      is_builtin: false,
      created_by: caller.userId,
    },
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_whitelist_created',
      payload:     { entry_id: entry.id, pattern },
    },
  })

  return NextResponse.json(entry, { status: 201 })
}
