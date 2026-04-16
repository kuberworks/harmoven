// app/(app)/settings/profile/page.tsx
// User profile — name update.
// Server Component: auth + data fetch. Delegates to ProfileClient.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getSessionLocale } from '@/lib/auth/session-helpers'
import { createT } from '@/lib/i18n/t'
import { ProfileClient } from './profile-client'

export const metadata: Metadata = { title: 'Profile — Settings' }

export default async function SettingsProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const user = session.user as Record<string, unknown>
  const locale = getSessionLocale(user)
  const t = createT(locale)

  return (
    <div className="space-y-6 max-w-2xl animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t('settings.profile')}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t('settings.profile_subtitle')}</p>
      </div>
      <ProfileClient
        initialName={(user.name as string | undefined) ?? ''}
        email={session.user.email}
      />
    </div>
  )
}
