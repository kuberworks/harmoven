// app/api/models/available/route.ts
// GET /api/models/available — list enabled LLM profiles for run-creation UI.
//
// Security:
//   - Requires a valid session (any authenticated user). No admin gate.
//   - Explicit Prisma `select` — never returns `config` (may contain api_key_enc or secrets).
//   - Decimal fields serialised to Number before JSON response.

import { NextRequest, NextResponse } from 'next/server'
import { auth }                      from '@/lib/auth'
import { headers }                   from 'next/headers'
import { db }                        from '@/lib/db/client'

export async function GET(_req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const profiles = await db.llmProfile.findMany({
    where: { enabled: true },
    select: {
      id:                        true,
      provider:                  true,
      model_string:              true,
      tier:                      true,
      context_window:            true,
      cost_per_1m_input_tokens:  true,
      cost_per_1m_output_tokens: true,
      modality:                  true,
    },
    orderBy: [
      { tier: 'asc' },
      { id:   'asc' },
    ],
  })

  // Serialise Decimal to Number so the response is plain JSON.
  const serialised = profiles.map(p => ({
    ...p,
    cost_per_1m_input_tokens:  Number(p.cost_per_1m_input_tokens),
    cost_per_1m_output_tokens: Number(p.cost_per_1m_output_tokens),
  }))

  return NextResponse.json({ profiles: serialised })
}
