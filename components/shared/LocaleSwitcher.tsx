'use client'

// components/shared/LocaleSwitcher.tsx
// Switches UI locale between en / fr.
// Calls PATCH /api/users/me/locale on change (Amendment 86).
// Spec: TECHNICAL.md §35, lib/i18n, UX.md §13.

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'

const SUPPORTED_LOCALES = ['en', 'fr'] as const
type Locale = typeof SUPPORTED_LOCALES[number]

const LABELS: Record<Locale, string> = { en: 'EN', fr: 'FR' }

interface LocaleSwitcherProps {
  currentLocale: Locale
}

export function LocaleSwitcher({ currentLocale }: LocaleSwitcherProps) {
  const [locale, setLocale] = useState<Locale>(currentLocale)
  const [isPending, startTransition] = useTransition()

  function switchLocale(next: Locale) {
    if (next === locale) return
    startTransition(async () => {
      try {
        await fetch('/api/users/me/locale', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale: next }),
        })
        setLocale(next)
        // Reload to apply new locale (SSR-rendered strings)
        window.location.reload()
      } catch {
        // Non-fatal — locale stays unchanged
      }
    })
  }

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5" aria-label="Language switcher">
      {SUPPORTED_LOCALES.map(loc => (
        <Button
          key={loc}
          variant={locale === loc ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => switchLocale(loc)}
          disabled={isPending}
          aria-pressed={locale === loc}
        >
          {LABELS[loc]}
        </Button>
      ))}
    </div>
  )
}
