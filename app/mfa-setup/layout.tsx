// app/mfa-setup/layout.tsx
// Standalone full-page layout for the MFA setup step.
// Shares the same centered aesthetic as (auth) but adds TranslationProvider
// (this page is accessed while authenticated — the (app) layout is not used).

import { cookies } from 'next/headers'
import { LOCALE_COOKIE } from '@/lib/i18n/types'
import { TranslationProvider } from '@/lib/i18n/client'

export default async function MfaSetupLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies()
  const locale = cookieStore.get(LOCALE_COOKIE)?.value === 'fr' ? 'fr' : 'en'

  return (
    <TranslationProvider locale={locale}>
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-surface-base px-4 py-12">
        {/* Warm gradient mesh — consistent with (auth) layout */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-1/4 -top-1/4 h-[600px] w-[600px] rounded-full bg-[var(--accent-amber-3)] opacity-30 blur-[120px]" />
          <div className="absolute -bottom-1/4 -right-1/4 h-[400px] w-[400px] rounded-full bg-[var(--accent-amber-3)] opacity-20 blur-[100px]" />
        </div>
        {/* Wordmark */}
        <div className="mb-8 flex flex-col items-center select-none animate-fade-in">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            Harmo<span className="text-[var(--accent-amber-9)]">ven</span>
          </span>
          <span className="mt-0.5 text-xs text-muted-foreground">AI orchestration platform</span>
        </div>
        <div className="relative z-10 w-full max-w-[420px] animate-fade-in">
          {children}
        </div>
      </div>
    </TranslationProvider>
  )
}
