// app/(app)/settings/page.tsx
// User preferences — UI level, language, Expert Mode.
// Server Component with client form for interactive toggles.
// UX spec §3.11 — Preferences.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { PreferencesClient } from './preferences-client'

export const metadata: Metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const user = session.user as Record<string, unknown>

  return (
    <div className="space-y-6 max-w-2xl animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your account and preferences.</p>
      </div>
      <PreferencesClient
        initialName={(user.name as string | undefined) ?? ''}
        initialEmail={session.user.email}
        initialLocale={(user.ui_locale as 'en' | 'fr' | undefined) ?? 'en'}
        initialExpertMode={(user.expert_mode as boolean | undefined) ?? false}
        initialUiLevel={(user.ui_level as string | undefined) ?? 'GUIDED'}
      />
    </div>
  )
}
