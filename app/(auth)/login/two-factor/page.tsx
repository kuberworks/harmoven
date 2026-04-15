// app/(auth)/login/two-factor/page.tsx
// TOTP challenge page — shown after successful credential login when 2FA is enabled.
// Better Auth sets a pending-2FA cookie (better-auth.two_factor) and REMOVES the
// session cookie while awaiting the TOTP code.
//
// Guard: if a full session already exists (twoFactorVerified) → /dashboard.
// We do NOT gate on the two_factor cookie because Better Auth may expire it
// after a failed attempt, which would cause a spurious redirect to /login.
// A direct-navigation user with no session and no two_factor cookie
// will be rejected by /api/auth/two-factor/verify-totp (401) and stays on the page.

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { TotpChallengeClient } from './totp-challenge-client'

export default async function TwoFactorChallengePage() {
  const session = await auth.api.getSession({ headers: await headers() })

  // Already fully verified — no need to show the challenge
  if (session?.session && (session.session as Record<string, unknown>).twoFactorVerified === true) {
    redirect('/dashboard')
  }

  return <TotpChallengeClient />
}
