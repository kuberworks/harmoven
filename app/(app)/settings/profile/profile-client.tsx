'use client'

// app/(app)/settings/profile/profile-client.tsx
// Interactive profile form — name update only.
// Calls PATCH /api/users/me

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button }  from '@/components/ui/button'
import { Input }   from '@/components/ui/input'
import { Label }   from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { useT } from '@/lib/i18n/client'
import { Loader2, User } from 'lucide-react'

interface Props {
  initialName: string
  email: string
}

export function ProfileClient({ initialName, email }: Props) {
  const { toast } = useToast()
  const t = useT()
  const [name, setName] = useState(initialName)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast({ title: 'Profile saved' })
    } catch {
      toast({ title: 'Failed to update profile', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <User className="h-4 w-4 text-muted-foreground" />
          Profile
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              maxLength={100}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={email} disabled className="opacity-60" />
            <p className="text-xs text-muted-foreground">{t('settings.email_readonly')}</p>
          </div>

          <Button type="submit" size="sm" disabled={saving || !name.trim()}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
