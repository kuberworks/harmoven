// app/api/v1/profiles/route.ts
// GET /api/v1/profiles — List LLM profiles active on this instance (public API v1).
// MISS-06 (audit gap).
//
// Returns the built-in profile catalog. No API keys or sensitive config is returned.
// Requires a valid API key or session (so external callers don't enumerate profiles).

import { NextRequest, NextResponse }   from 'next/server'
import { resolveCaller }               from '@/lib/auth/resolve-caller'
import { BUILT_IN_PROFILES }           from '@/lib/llm/profiles'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Return only safe fields — never base_url or api_key_env.
  const profiles = BUILT_IN_PROFILES.map(p => ({
    id:           p.id,
    provider:     p.provider,
    model_string: p.model_string,
    tier:         p.tier,
  }))

  return NextResponse.json({ profiles })
}
