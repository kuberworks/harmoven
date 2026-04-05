// app/(app)/settings/security/page.tsx
// Security settings — TOTP, passkeys, active sessions.
// Server Component: fetches sessions via Better Auth API.
// UX spec §3.11 — Security.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getSessionLocale } from '@/lib/auth/session-helpers'
import { createT } from '@/lib/i18n/t'
import { SecurityClient } from './security-client'

export const metadata: Metadata = { title: 'Security — Settings' }

export default async function SecurityPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  // Fetch all sessions for this user
  let activeSessions: Array<{
    id: string
    createdAt: Date
    updatedAt: Date
    ipAddress?: string | null
    userAgent?: string | null
    token: string
  }> = []

  try {
    const res = await auth.api.listSessions({ headers: await headers() })
    activeSessions = (res as typeof activeSessions | null) ?? []
  } catch {
    // Non-critical — show empty list
  }

  const locale = getSessionLocale(session.user as Record<string, unknown>)
  const t = createT(locale)

  const currentToken = session.session.token

  const serializedSessions = activeSessions.map((s) => ({
    id: s.token,
    createdAt:  s.createdAt.toISOString(),
    updatedAt:  s.updatedAt.toISOString(),
    ipAddress:  s.ipAddress ?? null,
    userAgent:  s.userAgent ?? null,
    current:    s.token === currentToken,
  }))

  // Passkeys fetched via Better Auth plugin (returns empty if not enabled)
  let passkeys: Array<{ id: string; name?: string | null; createdAt: string }> = []
  try {
    // @ts-expect-error - passkey plugin may not be typed
    const pkRes = await auth.api.listPasskeys?.({ headers: await headers() })
    if (Array.isArray(pkRes)) {
      passkeys = pkRes.map((pk) => ({
        id: pk.id,
        name: pk.name ?? null,
        createdAt: (pk.createdAt instanceof Date ? pk.createdAt : new Date(pk.createdAt)).toISOString(),
      }))
    }
  } catch {
    // Passkey plugin not enabled
  }

  // TOTP — check if user has TOTP enabled (via Better Auth session metadata)
  const userMeta = session.user as Record<string, unknown>
  const totpEnabled = Boolean(userMeta.twoFactorEnabled)

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">{t('settings.security_title')}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('settings.security_subtitle')}
        </p>
      </div>

      <SecurityClient
        sessions={serializedSessions}
        passkeys={passkeys}
        totpEnabled={totpEnabled}
      />
    </div>
  )
}
