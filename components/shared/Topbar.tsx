'use client'

// components/shared/Topbar.tsx
// Top navigation bar — project switcher, help, user menu.
// Spec: UX.md §2.1, DESIGN_SYSTEM.md §1.4.

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { LogOut, User, Settings, ChevronDown, HelpCircle, ExternalLink } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { ThemeToggle } from '@/components/shared/ThemeToggle'
import { LocaleSwitcher } from '@/components/shared/LocaleSwitcher'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils/cn'
import { useT } from '@/lib/i18n/client'

interface TopbarProps {
  userName?: string
  userEmail?: string
  locale?: 'en' | 'fr'
}

export function Topbar({ userName, userEmail, locale = 'en' }: TopbarProps) {
  const router = useRouter()
  const { toast } = useToast()
  const t = useT()
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const firstMenuItemRef = useRef<HTMLAnchorElement>(null)

  function handleHelp() {
    // Opens Harmoven documentation in a new tab.
    // Update this URL to the real docs site when available.
    window.open('https://github.com/harmoven/harmoven', '_blank', 'noopener,noreferrer')
  }

  // A11Y: close the user menu on Escape and return focus to trigger button
  useEffect(() => {
    if (!userMenuOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setUserMenuOpen(false)
        menuButtonRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [userMenuOpen])

  // A11Y: move focus to first menu item when menu opens
  useEffect(() => {
    if (userMenuOpen) {
      // rAF ensures the dropdown is rendered before we focus
      requestAnimationFrame(() => firstMenuItemRef.current?.focus())
    }
  }, [userMenuOpen])

  async function handleLogout() {
    try {
      await authClient.signOut({
        fetchOptions: { onSuccess: () => router.push('/login') },
      })
    } catch {
      // signOut failed — force navigation to /login to clear client state
      toast({ variant: 'destructive', title: 'Sign out error', description: 'Redirecting to login…' })
      router.push('/login')
    }
  }

  // Safe initials: guard against empty segments (double spaces, leading space)
  const initials = userName
    ? userName.split(' ').map(p => p[0] ?? '').filter(Boolean).join('').slice(0, 2).toUpperCase()
    : '?'

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface-raised px-4">
      {/* Left — breadcrumb slot (filled by pages via slot or context) */}
      <div id="topbar-breadcrumb" className="text-sm text-muted-foreground" />

      {/* Right — controls */}
      <div className="flex items-center gap-2">
        <LocaleSwitcher currentLocale={locale} />
        <ThemeToggle />

        {/* Help */}
        <button
          onClick={handleHelp}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-hover hover:text-foreground transition-colors duration-150"
          aria-label="Documentation"
        >
          <HelpCircle className="h-4 w-4" />
          <ExternalLink className="h-2.5 w-2.5 -ml-1 -mt-1.5 opacity-50" aria-hidden />
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            ref={menuButtonRef}
            onClick={() => setUserMenuOpen(o => !o)}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors duration-150"
            aria-expanded={userMenuOpen}
            aria-haspopup="menu"
            aria-controls="user-menu"
            aria-label={`User menu for ${userName ?? userEmail ?? 'user'}`}
          >
            {/* Avatar */}
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-amber-3)] text-xs font-semibold text-[var(--accent-amber-9)]" aria-hidden="true">
              {initials}
            </span>
            <span className="hidden sm:block text-foreground">{userName ?? userEmail}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform duration-150', userMenuOpen && 'rotate-180')} aria-hidden="true" />
          </button>

          {/* Dropdown */}
          {userMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setUserMenuOpen(false)}
                aria-hidden
              />
              <div
                id="user-menu"
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 w-52 rounded-card border border-border bg-surface-overlay p-1 shadow-lg animate-fade-in"
              >
                {userEmail && (
                  <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border mb-1" aria-hidden="true">
                    {userEmail}
                  </div>
                )}
                <MenuItem ref={firstMenuItemRef} href="/settings/profile" icon={User} label={t('settings.profile')} onClick={() => setUserMenuOpen(false)} />
                <MenuItem href="/settings" icon={Settings} label={t('nav.settings')} onClick={() => setUserMenuOpen(false)} />
                <div className="my-1 h-px bg-border" role="separator" />
                <button
                  role="menuitem"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/10 transition-colors duration-150"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  {t('auth.logout')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

const MenuItem = function MenuItem({
  href, icon: Icon, label, onClick, ref,
}: { href: string; icon: typeof User; label: string; onClick: () => void; ref?: React.Ref<HTMLAnchorElement> }) {
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      ref={ref}
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-surface-hover transition-colors duration-150"
    >
      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {label}
    </Link>
  )
}
