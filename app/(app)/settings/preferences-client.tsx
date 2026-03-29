'use client'

// app/(app)/settings/preferences-client.tsx
// Interactive preferences form — locale, expert mode, UI level.
// Calls PATCH /api/users/me and PATCH /api/users/me/locale.

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, User, Globe, Sliders } from 'lucide-react'

interface Props {
  initialName: string
  initialEmail: string
  initialLocale: 'en' | 'fr'
  initialExpertMode: boolean
  initialUiLevel: string
}

const UI_LEVELS = [
  { value: 'GUIDED',   label: 'Guided',   desc: 'Progress bar only — simple view' },
  { value: 'STANDARD', label: 'Standard', desc: 'Agent tree + activity feed' },
  { value: 'ADVANCED', label: 'Advanced', desc: 'DAG graph + costs + tokens' },
]

export function PreferencesClient({
  initialName,
  initialEmail,
  initialLocale,
  initialExpertMode,
  initialUiLevel,
}: Props) {
  const { toast } = useToast()
  const [name, setName] = useState(initialName)
  const [locale, setLocale] = useState<'en' | 'fr'>(initialLocale)
  const [expertMode, setExpertMode] = useState(initialExpertMode)
  const [uiLevel, setUiLevel] = useState(initialUiLevel)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPrefs, setSavingPrefs] = useState(false)

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    setSavingProfile(true)
    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast({ title: 'Profile updated' })
    } catch {
      toast({ title: 'Failed to update profile', variant: 'destructive' })
    } finally {
      setSavingProfile(false)
    }
  }

  async function savePreferences() {
    setSavingPrefs(true)
    try {
      const [localeRes, prefsRes] = await Promise.all([
        fetch('/api/users/me/locale', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        }),
        fetch('/api/users/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expert_mode: expertMode, ui_level: uiLevel }),
        }),
      ])
      if (!localeRes.ok || !prefsRes.ok) throw new Error('Save failed')
      toast({ title: 'Preferences saved' })
    } catch {
      toast({ title: 'Failed to save preferences', variant: 'destructive' })
    } finally {
      setSavingPrefs(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Profile section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="h-4 w-4 text-muted-foreground" />
            Profile
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={initialEmail} disabled className="opacity-60" />
              <p className="text-xs text-muted-foreground">Email cannot be changed here.</p>
            </div>
            <Button type="submit" size="sm" disabled={savingProfile}>
              {savingProfile && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save profile
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Language + UI preferences */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sliders className="h-4 w-4 text-muted-foreground" />
            Preferences
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Locale */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              <Label>Language</Label>
            </div>
            <div className="flex gap-2">
              {(['en', 'fr'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLocale(l)}
                  className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                    locale === l
                      ? 'border-accent-amber bg-accent-amber-3 text-accent-amber'
                      : 'border-surface-border bg-surface-raised text-muted-foreground hover:border-muted-foreground'
                  }`}
                >
                  {l === 'en' ? '🇬🇧 English' : '🇫🇷 Français'}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* UI Level */}
          <div className="space-y-2">
            <Label>Run detail level</Label>
            <div className="space-y-2">
              {UI_LEVELS.map((lvl) => (
                <button
                  key={lvl.value}
                  type="button"
                  onClick={() => setUiLevel(lvl.value)}
                  className={`w-full flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                    uiLevel === lvl.value
                      ? 'border-accent-amber bg-accent-amber-3'
                      : 'border-surface-border bg-surface-raised hover:bg-surface-hover'
                  }`}
                >
                  <div className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                    uiLevel === lvl.value ? 'border-accent-amber bg-accent-amber' : 'border-muted-foreground'
                  }`} />
                  <div>
                    <p className={`text-sm font-medium ${uiLevel === lvl.value ? 'text-accent-amber' : 'text-foreground'}`}>
                      {lvl.label}
                    </p>
                    <p className="text-xs text-muted-foreground">{lvl.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Expert Mode */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">Expert Mode</p>
              <p className="text-xs text-muted-foreground">
                Show DAG graph, raw tokens, cost breakdown, and code diffs.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={expertMode}
              onClick={() => setExpertMode((v) => !v)}
              className={`relative h-6 w-11 shrink-0 rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                expertMode ? 'border-accent-amber bg-accent-amber' : 'border-surface-border bg-surface-hover'
              }`}
            >
              <span
                className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  expertMode ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <Button size="sm" onClick={savePreferences} disabled={savingPrefs}>
            {savingPrefs && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save preferences
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
