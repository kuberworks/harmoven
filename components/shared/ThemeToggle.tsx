'use client'

// components/shared/ThemeToggle.tsx
// Dark / Light / Auto toggle. Stores preference in localStorage + syncs to server.
// DESIGN_SYSTEM.md §1.1-1.2: three modes, time-aware auto logic.

import { useEffect, useState } from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Theme = 'dark' | 'light' | 'auto'

const THEMES: { value: Theme; label: string; icon: typeof Moon }[] = [
  { value: 'dark',  label: 'Dark',  icon: Moon    },
  { value: 'light', label: 'Light', icon: Sun     },
  { value: 'auto',  label: 'Auto',  icon: Monitor },
]

function resolveAutoTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark'
  const osPrefers = window.matchMedia('(prefers-color-scheme: dark)').matches
  return osPrefers ? 'dark' : 'light'
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'auto' ? resolveAutoTheme() : theme
  document.documentElement.classList.remove('dark', 'light')
  document.documentElement.classList.add(resolved)
  localStorage.setItem('harmoven-theme', theme)
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    const stored = (localStorage.getItem('harmoven-theme') ?? 'dark') as Theme
    setTheme(stored)
    applyTheme(stored)
  }, [])

  function cycle() {
    const next: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  const current = THEMES.find(t => t.value === theme) ?? THEMES[0]!
  const Icon = current.icon

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Theme: ${current.label}`}
      title={`Theme: ${current.label}`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  )
}
