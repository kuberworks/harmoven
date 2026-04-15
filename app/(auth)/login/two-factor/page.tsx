// app/(auth)/login/two-factor/page.tsx
// TOTP challenge page — shown after successful credential login when 2FA is enabled.
// Better Auth sets a pending-2FA cookie (better-auth.two_factor) and REMOVES the
// session cookie while awaiting the TOTP code.
//
// Guard rules:
//   - No 2FA pending cookie AND no session  → direct navigation, redirect to /login
//   - Full verified session already          → already logged in, redirect to /dashboard

import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { TotpChallengeClient } from './totp-challenge-client'

// Better Auth signs cookies with a prefix. The raw cookie name used by the twoFactor
// plugin is "two_factor"; Better Auth stores it as "better-auth.two_factor".
const TWO_FACTOR_PENDING_COOKIE = 'better-auth.two_factor'

export default async function TwoFactorChallengePage() {
  const cookieStore = await cookies()
  const hasTwoFactorPending = cookieStore.has(TWO_FACTOR_PENDING_COOKIE)

  if (!hasTwoFactorPending) {
    // No pending 2FA challenge — check if already fully authenticated
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session) redirect('/login')
    // Fully verified session → already logged in
    redirect('/dashboard')
  }

  return <TotpChallengeClient />
}
