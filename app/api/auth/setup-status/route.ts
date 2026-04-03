// app/api/auth/setup-status/route.ts
// GET /api/auth/setup-status — Returns instance setup state.
// Used by the /setup wizard to determine if initial configuration is complete.
// Public route (no auth required) — only returns boolean flags, no sensitive data.
//
// CVE-HARM-006: user_count removed from response — it is not needed by the
// setup wizard and leaks instance occupancy to unauthenticated callers.
//
// Spec: middleware.ts /setup is public, implying a setup-status check endpoint.

import { NextResponse } from 'next/server'
import { db }           from '@/lib/db/client'

export async function GET() {
  const userCount = await db.user.count()

  const hasAdmin = userCount > 0
  // setup_complete: all mandatory steps are done (admin created).
  const setupComplete = hasAdmin

  // L-3 fix: has_llm_profile removed — it is not needed by the setup wizard
  // and leaks instance occupancy to unauthenticated callers.
  // WARN-005 FIX: expose both `setup_complete` (canonical) and `setup_required` (inverse alias).
  return NextResponse.json({
    setup_complete: setupComplete,
    setup_required: !setupComplete,
    has_admin:      hasAdmin,
  })
}
