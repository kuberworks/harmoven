'use client'

// components/shared/ExpertModeToggle.tsx
// 4-level UI disclosure toggle stored in user preferences.
// Levels: GUIDED → STANDARD → ADVANCED → EXPERT
// Persists to: PATCH /api/users/me { ui_level }

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { ChevronDown, Layers } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type UiLevel = 'GUIDED' | 'STANDARD' | 'ADVANCED' | 'EXPERT'

const LEVELS: { value: UiLevel; label: string; description: string }[] = [
  { value: 'GUIDED',   label: 'Guided',   description: 'Progress bar only — simplified view' },
  { value: 'STANDARD', label: 'Standard', description: 'Agent tree + activity feed' },
  { value: 'ADVANCED', label: 'Advanced', description: '+ Agent detail drawer' },
  { value: 'EXPERT',   label: 'Expert',   description: '+ DAG graph, tokens, costs, code tabs' },
]

const LEVEL_VARIANT: Record<UiLevel, 'default' | 'secondary' | 'outline' | 'paused'> = {
  GUIDED:   'secondary',
  STANDARD: 'outline',
  ADVANCED: 'outline',
  EXPERT:   'paused',
}

interface ExpertModeToggleProps {
  value: UiLevel
  onChange?: (level: UiLevel) => void
  /** If true, persists the new level to the API */
  persist?: boolean
}

export function ExpertModeToggle({ value, onChange, persist = true }: ExpertModeToggleProps) {
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const current = LEVELS.find((l) => l.value === value) ?? LEVELS[0]!

  async function handleSelect(level: UiLevel) {
    if (level === value) return
    onChange?.(level)
    if (!persist) return

    setSaving(true)
    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui_level: level }),
      })
      if (!res.ok) throw new Error('Failed to update UI level')
      toast({ title: `View switched to ${LEVELS.find((l) => l.value === level)?.label}` })
    } catch {
      toast({ title: 'Failed to save view preference', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          disabled={saving}
          aria-label={`View level: ${current.label}`}
        >
          <Layers className="h-3.5 w-3.5" aria-hidden />
          <Badge variant={LEVEL_VARIANT[value]} className="text-xs font-medium">
            {current.label}
          </Badge>
          <ChevronDown className="h-3 w-3 opacity-50" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>View level</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LEVELS.map((level) => (
          <DropdownMenuItem
            key={level.value}
            onClick={() => handleSelect(level.value)}
            className="flex-col items-start gap-0.5"
          >
            <div className="flex items-center justify-between w-full">
              <span className="font-medium text-sm">{level.label}</span>
              {level.value === value && (
                <Badge variant="outline" className="text-xs ml-2">active</Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{level.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
