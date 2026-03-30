// app/(app)/layout.tsx
// Authenticated shell — sidebar + topbar.
// Server Component: reads session from Better Auth, redirects on 401.
// Spec: FRONTEND-SDD-PROMPT.md Priority 1, UX.md §1.4, §2.1.

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getInstanceRole, getSessionLocale } from '@/lib/auth/session-helpers'
import { Sidebar } from '@/components/shared/Sidebar'
import { Topbar } from '@/components/shared/Topbar'
import { UpdateBannerAsync } from '@/components/admin/UpdateBannerAsync'
import { TranslationProvider } from '@/lib/i18n/client'
import { MobileSidebarProvider } from '@/components/shared/MobileSidebarContext'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/login')
  }

  const user = session.user as Record<string, unknown>
  const instanceRole = getInstanceRole(user)
  const locale = getSessionLocale(user)

  return (
    <TranslationProvider locale={locale}>
      <MobileSidebarProvider>
      <div className="flex h-screen overflow-hidden bg-surface-base">
      {/* A11Y: skip-navigation link — visible on focus for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:left-2 focus:top-2 focus:rounded-md focus:bg-surface-overlay focus:px-4 focus:py-2 focus:text-sm focus:text-foreground focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      {/* Left sidebar */}
      <Sidebar instanceRole={instanceRole} />

      {/* Main column */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Update banner (admin only, self-fetching) */}
        {(instanceRole === 'admin' || instanceRole === 'instance_admin') && (
          <UpdateBannerAsync />
        )}

        {/* Topbar */}
        <Topbar
          userName={user.name as string | undefined}
          userEmail={user.email as string}
          locale={locale}
        />

        {/* Page content */}
        <main id="main-content" className="flex-1 overflow-y-auto p-3 sm:p-6" tabIndex={-1}>
          <div className="mx-auto max-w-[1200px]">
            {children}
          </div>
        </main>
      </div>      </div>
      </MobileSidebarProvider>
    </TranslationProvider>
  )
}
