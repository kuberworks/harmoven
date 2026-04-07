'use client'

// app/(app)/settings/settings-nav.tsx
// Tab navigation bar shared by all /settings/* pages.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useT } from '@/lib/i18n/client'

const NAV_ITEMS = [
  { href: '/settings',          labelKey: 'settings.preferences' as const },
  { href: '/settings/profile',  labelKey: 'settings.profile'     as const },
  { href: '/settings/security', labelKey: 'settings.security_title' as const },
  { href: '/settings/api-keys', labelKey: 'api_keys.title'       as const },
]

export function SettingsNav() {
  const pathname = usePathname()
  const t = useT()

  return (
    <nav className="flex gap-1 border-b border-surface-border pb-0 mb-6" aria-label="Settings navigation">
      {NAV_ITEMS.map(({ href, labelKey }) => {
        const isActive = href === '/settings'
          ? pathname === '/settings'
          : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={[
              'px-3 py-2 text-sm font-medium rounded-t-md -mb-px border-b-2 transition-colors',
              isActive
                ? 'border-accent-amber text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-surface-border',
            ].join(' ')}
            aria-current={isActive ? 'page' : undefined}
          >
            {t(labelKey)}
          </Link>
        )
      })}
    </nav>
  )
}
