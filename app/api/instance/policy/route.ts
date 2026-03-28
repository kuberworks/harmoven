// app/api/instance/policy/route.ts
// GET /api/instance/policy — Public endpoint returning non-sensitive instance policy.
// Called by the middleware (parallel to get-session) with a module-level TTL cache.
//
// SECURITY: Only boolean policy flags — no secrets, no user data.
// Public (no auth required) — same rationale as /api/auth/setup-status.

import { NextResponse } from 'next/server'
import { db }           from '@/lib/db/client'

export async function GET() {
  const row = await db.systemSetting.findUnique({
    where: { key: 'security.mfa_required_for_admin' },
  })

  let mfa_required_for_admin = true  // default: enforce
  if (row) {
    try { mfa_required_for_admin = JSON.parse(row.value) as boolean } catch { /* keep default */ }
  }

  return NextResponse.json(
    { mfa_required_for_admin },
    {
      headers: {
        // Allow the middleware to cache this response for up to 60 seconds.
        'Cache-Control': 'private, max-age=60',
      },
    },
  )
}
