// app/(app)/layout.tsx
// Authenticated shell — sidebar + topbar.
// Server Component: reads session from Better Auth, redirects on 401.
// Spec: FRONTEND-SDD-PROMPT.md Priority 1, UX.md §1.4, §2.1.

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { Sidebar } from '@/components/shared/Sidebar'
import { Topbar } from '@/components/shared/Topbar'
import { UpdateBannerAsync } from '@/components/admin/UpdateBannerAsync'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session?.user) {
    redirect('/login')
  }

  const user = session.user
  // role field is added by the better-auth admin plugin
  const instanceRole = ((user as Record<string, unknown>).role as string | undefined) ?? 'user'
  const locale = ((user as Record<string, unknown>).ui_locale as 'en' | 'fr' | undefined) ?? 'en'

  return (
    <div className="flex h-screen overflow-hidden bg-surface-base">
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
          userName={user.name ?? undefined}
          userEmail={user.email}
          locale={locale}
        />

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-[1200px]">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
