// app/api/users/me/locale/route.ts
// Amendment 86.4 — save the user's UI locale preference.
//
// PATCH /api/users/me/locale
//   Body: { ui_locale: 'en' | 'fr' | null, transparency_language?: string | null }
//   Auth: requires valid session (any authenticated user can change their own prefs)
//   Returns: 200 { ok: true } | 400 { error } | 401

import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { SUPPORTED_LOCALES } from '@/lib/i18n/types'

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const SupportedLocaleSchema = z.enum(SUPPORTED_LOCALES as [string, ...string[]])

const LocalePatchSchema = z.object({
  /** null = auto-detect from browser */
  ui_locale: SupportedLocaleSchema.nullable().optional(),
  /** null = follows ui_locale automatically */
  transparency_language: SupportedLocaleSchema.nullable().optional(),
})

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  // Authenticate
  const session = await auth.api.getSession({
    headers: await headers(),
  })
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Parse + validate body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = LocalePatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid locale value', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  // Build update payload — only update fields that were sent.
  const data: Record<string, string | null> = {}
  if ('ui_locale' in parsed.data) {
    data.ui_locale = parsed.data.ui_locale ?? null
  }
  if ('transparency_language' in parsed.data) {
    data.transparency_language = parsed.data.transparency_language ?? null
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true })   // no-op
  }

  await db.user.update({
    where: { id: session.user.id },
    data,
  })

  return NextResponse.json({ ok: true })
}
