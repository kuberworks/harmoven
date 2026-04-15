// app/mfa-setup/page.tsx
// Dedicated MFA setup page — shown to instance_admin accounts that have not
// yet enabled TOTP when MFA enforcement is active.
//
// The middleware redirects here (instead of /settings/security?setup_mfa=1).
// Once the user activates TOTP, the client component redirects to /dashboard.

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { MfaSetupClient } from './mfa-setup-client'

export default async function MfaSetupPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  // If TOTP is already enabled, there's nothing to do here.
  const user = session.user as Record<string, unknown>
  if (user.twoFactorEnabled === true) redirect('/dashboard')

  return <MfaSetupClient />
}
