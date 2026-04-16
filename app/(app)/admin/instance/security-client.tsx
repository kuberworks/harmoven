'use client'

// Toggle MFA requirement for admins via PATCH /api/admin/security

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

interface Props {
  mfaRequiredForAdmin: boolean
  envOverrideActive:   boolean
}

export function InstanceSecurityClient({ mfaRequiredForAdmin, envOverrideActive }: Props) {
  const router   = useRouter()
  const [value,  setValue]  = useState(mfaRequiredForAdmin)
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [saved,  setSaved]  = useState(false)

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/admin/security', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mfa_required_for_admin: value }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error((d as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="pt-4 pb-5 space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={value}
            disabled={envOverrideActive}
            onChange={(e) => { setValue(e.target.checked); setSaved(false) }}
            className="mt-0.5 h-4 w-4 rounded border-surface-border accent-amber-500"
          />
          <div>
            <p className="text-sm font-medium text-foreground">
              Require MFA for instance admins
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Admins without TOTP or a passkey will be blocked from accessing the admin panel.
            </p>
            {envOverrideActive && (
              <p className="text-xs text-amber-400 mt-1">
                Disabled by environment variable — change HARMOVEN_ENFORCE_ADMIN_MFA to re-enable.
              </p>
            )}
          </div>
        </label>

        {error  && <p className="text-xs text-destructive">{error}</p>}
        {saved  && <p className="text-xs text-success">Settings saved.</p>}

        <Button
          size="sm"
          disabled={saving || envOverrideActive}
          onClick={handleSave}
        >
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </CardContent>
    </Card>
  )
}
