import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { cookies } from 'next/headers'
import { Toaster } from '@/components/ui/use-toast'
import { LOCALE_COOKIE } from '@/lib/i18n/types'
import '@/app/globals.css'

export const metadata: Metadata = {
  title: { template: '%s — Harmoven', default: 'Harmoven' },
  description: 'AI orchestration platform',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read locale from the persistent cookie set when the user changes language.
  // No DB call — cookie is maintained by PATCH /api/users/me/locale.
  // Falls back to 'en' for unauthenticated/new sessions.
  const cookieStore = await cookies()
  const lang = cookieStore.get(LOCALE_COOKIE)?.value === 'fr' ? 'fr' : 'en'

  return (
    <html lang={lang} className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
