// app/api/admin/marketplace/git-whitelist/[id]/route.ts
// PATCH  /api/admin/marketplace/git-whitelist/:id  — update
// DELETE /api/admin/marketplace/git-whitelist/:id  — delete (reject if is_builtin)
//
// A.2.2 — SEC-08, SEC-11

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'

const PRIVATE_PREFIXES = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d+)?$/,
]

function isValidHostnamePattern(pattern: string): boolean {
  if (!pattern || pattern.length > 253) return false
  for (const re of PRIVATE_PREFIXES) {
    if (re.test(pattern)) return false
  }
  const sanitized = pattern.replace(/^\*\./, '')
  return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(sanitized) || /^[a-z0-9]+$/i.test(sanitized)
}

const PatchSchema = z.object({
  label:       z.string().min(1).max(128).optional(),
  pattern:     z.string().min(1).max(253).optional(),
  description: z.string().max(512).nullable().optional(),
  enabled:     z.boolean().optional(),
})

type RouteParams = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
  const { id } = await params

  const entry = await db.gitUrlWhitelistEntry.findUnique({ where: { id } })
  if (!entry) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 })
  }

  const { label, pattern, description, enabled } = parsed.data

  if (pattern !== undefined && !isValidHostnamePattern(pattern)) {
    return NextResponse.json({ error: 'INVALID_PATTERN' }, { status: 422 })
  }

  // Check duplicate if pattern is changing
  if (pattern !== undefined && pattern !== entry.pattern) {
    const dupe = await db.gitUrlWhitelistEntry.findUnique({ where: { pattern } })
    if (dupe) return NextResponse.json({ error: 'DUPLICATE_PATTERN' }, { status: 409 })
  }

  const updated = await db.gitUrlWhitelistEntry.update({
    where: { id },
    data: {
      ...(label !== undefined       ? { label }       : {}),
      ...(pattern !== undefined     ? { pattern }     : {}),
      ...(description !== undefined ? { description } : {}),
      ...(enabled !== undefined     ? { enabled }     : {}),
    },
  })

  const actionType = enabled !== undefined
    ? 'marketplace_whitelist_toggled'
    : 'marketplace_whitelist_updated'

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: actionType,
      payload:     { entry_id: id, changes: parsed.data },
    },
  })

  return NextResponse.json(updated)
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
  const { id } = await params

  const entry = await db.gitUrlWhitelistEntry.findUnique({ where: { id } })
  if (!entry) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (entry.is_builtin) {
    return NextResponse.json({ error: 'BUILTIN_ENTRY_PROTECTED', message: 'Built-in entries cannot be deleted.' }, { status: 403 })
  }

  await db.gitUrlWhitelistEntry.delete({ where: { id } })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_whitelist_deleted',
      payload:     { entry_id: id, pattern: entry.pattern },
    },
  })

  return new NextResponse(null, { status: 204 })
}
