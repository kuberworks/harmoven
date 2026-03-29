// app/api/users/me/data/route.ts
// GET /api/users/me/data — Personal data export (RGPD Art.20 — Right to portability)
//
// ── Security ──────────────────────────────────────────────────────────────────
//  • Requires an active session (not callable with an API key).
//  • Rate-limited via response headers: 1 export per 24 h is the UI convention;
//    the backend will not enforce a hard limit (no Redis dependency here) but
//    the endpoint is session-gated so it cannot be abused anonymously.
//
// ── Response ──────────────────────────────────────────────────────────────────
//  • Content-Type: application/json; attachment
//  • Content-Disposition: attachment; filename="harmoven-data-export-<date>.json"
//  • Cache-Control: private, no-store (PII must never be cached by a CDN)

import { NextRequest, NextResponse } from 'next/server'
import { headers }                    from 'next/headers'
import { auth }                       from '@/lib/auth'
import { buildUserDataExport }        from '@/lib/auth/data-export'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  try {
    const exportData = await buildUserDataExport(userId)

    const date     = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const filename = `harmoven-data-export-${date}.json`
    const body     = JSON.stringify(exportData, null, 2)

    return new NextResponse(body, {
      status:  200,
      headers: {
        'Content-Type':        'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control':       'private, no-store',
      },
    })
  } catch (err) {
    console.error('[data-export] Failed to generate export for user', userId, err)
    return NextResponse.json(
      { error: 'Failed to generate data export. Please try again later.' },
      { status: 500 },
    )
  }
}
