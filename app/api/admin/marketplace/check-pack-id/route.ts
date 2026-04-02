// app/api/admin/marketplace/check-pack-id/route.ts
// GET /api/admin/marketplace/check-pack-id?id=<slug>
// Client-side debounced pack_id uniqueness check.
//
// U13 — SEC-08

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin } from '@/lib/auth/rbac'

const PACK_ID_RE = /^[a-z0-9_]{1,64}$/

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'MISSING_ID' }, { status: 400 })
  if (!PACK_ID_RE.test(id)) {
    return NextResponse.json({ available: false, reason: 'INVALID_FORMAT' })
  }

  const existing = await db.mcpSkill.findUnique({
    where:  { pack_id: id },
    select: { id: true },
  })

  return NextResponse.json({ available: existing === null })
}
