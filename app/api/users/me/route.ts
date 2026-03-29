// app/api/users/me/route.ts
// PATCH /api/users/me — Update user profile (name, expert_mode, ui_level)
// DELETE /api/users/me — Permanently delete own account (RGPD Art.17)
//
// ── DELETE security requirements ──────────────────────────────────────────
//   • Requires a valid session (no API key — account deletion is a user action)
//   • Body MUST contain:
//       - password:  string  — re-authentication proves unambiguous consent (Art.7)
//       - confirm:   literal "DELETE MY ACCOUNT" — explicit typed confirmation
//         (same UX pattern as GitHub, Vercel, Stripe)
//   • Pseudonymization strategy runs BEFORE the User row is deleted:
//       - FK nullable fields → NULL (Run.created_by, PipelineTemplate.created_by, …)
//       - Non-nullable plain-string fields → "__deleted__" sentinel
//       - AuditLog.actor immutable — see lib/auth/account-deletion.ts for rationale
//   • An AuditLog entry is written BEFORE deletion (actor='system', action_type='user.account.deleted')
//
// ── PATCH notes ───────────────────────────────────────────────────────────
//   • Callable from the Settings page (PreferencesClient component)
//   • Accepts any subset of { name, expert_mode, ui_level }
//   • Does NOT accept email changes (requires email-change flow with verification)

import { NextRequest, NextResponse } from 'next/server'
import { headers }                    from 'next/headers'
import { z }                          from 'zod'
import { auth }                       from '@/lib/auth'
import { db }                         from '@/lib/db/client'
import { deleteUserAccount }          from '@/lib/auth/account-deletion'

// ─── PATCH schema ─────────────────────────────────────────────────────────────

const PatchBody = z.object({
  name:        z.string().min(1).max(128).optional(),
  expert_mode: z.boolean().optional(),
  ui_level:    z.enum(['GUIDED', 'STANDARD', 'ADVANCED']).optional(),
}).strict()

// ─── DELETE schema ────────────────────────────────────────────────────────────
// Both fields are mandatory.
// `confirm` must be the exact string "DELETE MY ACCOUNT" (case-sensitive).
// This is a deliberate friction-increasing measure — the user must consciously
// type a sentence, not just click a button.

const DeleteBody = z.object({
  /** Re-authentication: user's current password. Proves consent (RGPD Art.7). */
  password: z.string().min(1, 'Password is required'),
  /** Typed confirmation: must be exactly "DELETE MY ACCOUNT". */
  confirm:  z.literal('DELETE MY ACCOUNT', {
    errorMap: () => ({
      message: 'You must type "DELETE MY ACCOUNT" to confirm',
    }),
  }),
}).strict()

// ─── PATCH /api/users/me ─────────────────────────────────────────────────────

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PatchBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    )
  }

  const data: Record<string, unknown> = {}
  if (parsed.data.name        !== undefined) data.name        = parsed.data.name
  if (parsed.data.expert_mode !== undefined) data.expert_mode = parsed.data.expert_mode
  if (parsed.data.ui_level    !== undefined) data.ui_level    = parsed.data.ui_level

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true })
  }

  await db.user.update({
    where: { id: session.user.id },
    data,
  })

  return NextResponse.json({ ok: true })
}

// ─── DELETE /api/users/me ─────────────────────────────────────────────────────

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  // ── Parse + validate body ─────────────────────────────────────────────────
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = DeleteBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:   'Validation failed',
        details: parsed.error.flatten(),
        // Surface the confirm field hint explicitly so the client can guide the user
        hint: 'Body must be { "password": "<current_password>", "confirm": "DELETE MY ACCOUNT" }',
      },
      { status: 422 },
    )
  }

  // ── Execute deletion with pseudonymization ────────────────────────────────
  try {
    await deleteUserAccount(userId, parsed.data.password)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code

    if (code === 'WRONG_PASSWORD') {
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
    }

    if (code === 'NO_CREDENTIAL_ACCOUNT') {
      // User authenticates via passkey/social only — no password to verify.
      // For now: return a specific error with a hint.
      // TODO: add passkey re-authentication flow for passwordless users.
      return NextResponse.json(
        {
          error: 'No password account found.',
          hint:  'This account uses passkey or social login. '
               + 'Contact support to request account deletion, or add a password in Settings first.',
        },
        { status: 422 },
      )
    }

    // Unexpected error — do not expose internal details
    console.error('[account-deletion] unexpected error for user', userId, err)
    return NextResponse.json(
      { error: 'Internal server error — account was not deleted' },
      { status: 500 },
    )
  }

  // ── Response ──────────────────────────────────────────────────────────────
  // The session cookie is now invalid (User + all Sessions deleted).
  // Returning 200 with a redirect hint; the client clears the cookie on load.
  return NextResponse.json(
    {
      ok:      true,
      message: 'Your account has been permanently deleted.',
      redirect: '/login',
    },
    { status: 200 },
  )
}
