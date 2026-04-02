// app/api/admin/marketplace/registries/[id]/route.ts
// PATCH  /api/admin/marketplace/registries/:id  — update
// DELETE /api/admin/marketplace/registries/:id  — delete (reject if is_builtin)
//
// A.3.3 — SEC-08, SEC-11, SEC-14

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { encryptValue } from '@/lib/utils/credential-crypto-ext'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import { revalidatePath } from 'next/cache'

const PatchSchema = z.object({
  label:       z.string().min(1).max(128).optional(),
  feed_url:    z.string().url().max(2048).refine((u) => u.startsWith('https://'), {
    message: 'feed_url must use HTTPS',
  }).optional(),
  auth_header: z.string().min(1).max(2048).nullable().optional(),
  enabled:     z.boolean().optional(),
})

type RouteParams = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)
  const { id } = await params

  const reg = await db.marketplaceRegistry.findUnique({ where: { id } })
  if (!reg) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 })
  }

  const { label, feed_url, auth_header, enabled } = parsed.data

  // SEC-15: SSRF check if URL changes
  if (feed_url !== undefined) {
    try {
      await assertNotPrivateHost(feed_url)
    } catch {
      return NextResponse.json({ error: 'SSRF_BLOCKED' }, { status: 422 })
    }
    // Check duplicate
    if (feed_url !== reg.feed_url) {
      const dupe = await db.marketplaceRegistry.findUnique({ where: { feed_url } })
      if (dupe) return NextResponse.json({ error: 'DUPLICATE_FEED_URL' }, { status: 409 })
    }
  }

  // SEC-14: encrypt new auth_header; null = remove
  let auth_header_enc: string | null | undefined
  if (auth_header !== undefined) {
    auth_header_enc = auth_header === null ? null : encryptValue(auth_header)
  }

  const updated = await db.marketplaceRegistry.update({
    where: { id },
    data: {
      ...(label !== undefined            ? { label }                   : {}),
      ...(feed_url !== undefined         ? { feed_url }                : {}),
      ...(auth_header_enc !== undefined  ? { auth_header_enc }         : {}),
      ...(enabled !== undefined          ? { enabled }                 : {}),
    },
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_registry_updated',
      payload:     { registry_id: id, changes: { label, feed_url, enabled, auth_changed: auth_header !== undefined } },
    },
  })

  // U14: revalidate browse tab cache on enable/disable
  if (enabled !== undefined) {
    revalidatePath('/marketplace')
  }

  const { auth_header_enc: _enc, ...safe } = updated as typeof updated & { auth_header_enc: string | null }
  return NextResponse.json({ ...safe, has_auth: (updated as { auth_header_enc?: string | null }).auth_header_enc !== null })
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)
  const { id } = await params

  const reg = await db.marketplaceRegistry.findUnique({ where: { id } })
  if (!reg) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (reg.is_builtin) {
    return NextResponse.json({ error: 'BUILTIN_REGISTRY_PROTECTED', message: 'Built-in registries cannot be deleted.' }, { status: 403 })
  }

  await db.marketplaceRegistry.delete({ where: { id } })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_registry_deleted',
      payload:     { registry_id: id, feed_url: reg.feed_url },
    },
  })

  return new NextResponse(null, { status: 204 })
}
