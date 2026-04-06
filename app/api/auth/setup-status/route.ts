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
  // setup.wizard_complete is written by POST /api/setup/admin on first-run wizard
  // completion. Checking this key (rather than user.count()) means bootstrap seed
  // users created by `npm run db:seed` do NOT prematurely mark setup as complete.
  const setting = await db.systemSetting.findUnique({ where: { key: 'setup.wizard_complete' } })
  const setupComplete = setting?.value === 'true'

  // L-3 fix: has_llm_profile removed — it is not needed by the setup wizard
  // and leaks instance occupancy to unauthenticated callers.
  // WARN-005 FIX: expose both `setup_complete` (canonical) and `setup_required` (inverse alias).
  return NextResponse.json({
    setup_complete: setupComplete,
    setup_required: !setupComplete,
  })
}
