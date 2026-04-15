// app/(auth)/login/two-factor/page.tsx
// TOTP challenge page — shown after successful credential login when 2FA is enabled.
// Better Auth sets a pending-2FA session cookie; this page collects the code and
// completes the authentication via POST /api/auth/two-factor/verify-totp.
//
// Guard: direct navigation (no pending 2FA session) → redirect to /login.

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { TotpChallengeClient } from './totp-challenge-client'

export default async function TwoFactorChallengePage() {
  const session = await auth.api.getSession({ headers: await headers() })

  // No session at all → not in the login flow, go to /login
  if (!session) redirect('/login')

  // Already fully verified → go to dashboard
  if ((session.session as Record<string, unknown>)?.twoFactorVerified === true) {
    redirect('/dashboard')
  }

  return <TotpChallengeClient />
}
