'use client'

// components/shared/Topbar.tsx
// Top navigation bar — project switcher, help, user menu.
// Spec: UX.md §2.1, DESIGN_SYSTEM.md §1.4.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut, User, Settings, ChevronDown, HelpCircle } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { ThemeToggle } from '@/components/shared/ThemeToggle'
import { LocaleSwitcher } from '@/components/shared/LocaleSwitcher'
import { cn } from '@/lib/utils/cn'

interface TopbarProps {
  userName?: string
  userEmail?: string
  locale?: 'en' | 'fr'
}

export function Topbar({ userName, userEmail, locale = 'en' }: TopbarProps) {
  const router = useRouter()
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  async function handleLogout() {
    await authClient.signOut({
      fetchOptions: { onSuccess: () => router.push('/login') },
    })
  }

  const initials = userName
    ? userName.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()
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
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-hover hover:text-foreground transition-colors duration-150"
          aria-label="Help"
        >
          <HelpCircle className="h-4 w-4" />
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setUserMenuOpen(o => !o)}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-hover transition-colors duration-150"
            aria-expanded={userMenuOpen}
            aria-haspopup="menu"
          >
            {/* Avatar */}
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-amber-3)] text-xs font-semibold text-[var(--accent-amber-9)]">
              {initials}
            </span>
            <span className="hidden sm:block text-foreground">{userName ?? userEmail}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform duration-150', userMenuOpen && 'rotate-180')} />
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
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 w-52 rounded-card border border-border bg-surface-overlay p-1 shadow-lg animate-fade-in"
              >
                {userEmail && (
                  <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border mb-1">
                    {userEmail}
                  </div>
                )}
                <MenuItem href="/settings/profile" icon={User} label="Profile" onClick={() => setUserMenuOpen(false)} />
                <MenuItem href="/settings" icon={Settings} label="Settings" onClick={() => setUserMenuOpen(false)} />
                <div className="my-1 h-px bg-border" />
                <button
                  role="menuitem"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/10 transition-colors duration-150"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

function MenuItem({
  href, icon: Icon, label, onClick,
}: { href: string; icon: typeof User; label: string; onClick: () => void }) {
  return (
    <a
      href={href}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground hover:bg-surface-hover transition-colors duration-150"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      {label}
    </a>
  )
}
