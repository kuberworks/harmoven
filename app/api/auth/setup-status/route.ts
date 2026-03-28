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
  const modelCount = await db.llmProfile.count()

  // Only expose boolean flags — never the raw counts.
  return NextResponse.json({
    setup_complete:  userCount > 0,
    has_admin:       userCount > 0,
    has_llm_profile: modelCount > 0,
  })
}
