// app/(app)/settings/profile/page.tsx
// User profile — name update.
// Server Component: auth + data fetch. Delegates to ProfileClient.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { ProfileClient } from './profile-client'

export const metadata: Metadata = { title: 'Profile — Settings' }

export default async function SettingsProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const user = session.user as Record<string, unknown>

  return (
    <div className="space-y-6 max-w-2xl animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Profile</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Update your display name and view account details.</p>
      </div>
      <ProfileClient
        initialName={(user.name as string | undefined) ?? ''}
        email={session.user.email}
      />
    </div>
  )
}
