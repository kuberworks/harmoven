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

  const hasAdmin      = userCount > 0
  const hasLlmProfile = modelCount > 0
  // setup_complete: all mandatory steps are done (admin created).
  // LLM profile is strongly recommended but not blocking — the wizard
  // shows has_llm_profile separately so the UI can guide configuration.
  const setupComplete = hasAdmin

  // WARN-005 FIX: expose both `setup_complete` (canonical) and `setup_required`
  // (inverse, consumed by some frontend components via types/api.ts generated types).
  // Both are present so consumers can use whichever reads more naturally.
  return NextResponse.json({
    setup_complete:  setupComplete,
    setup_required:  !setupComplete,   // inverse alias — keeps frontend contract unambiguous
    has_admin:       hasAdmin,
    has_llm_profile: hasLlmProfile,
  })
}
