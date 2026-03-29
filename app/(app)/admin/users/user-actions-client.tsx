'use client'

// app/(app)/admin/users/user-actions-client.tsx
// Ban / Unban actions for a user row in the admin users list.
// Only instance_admin can do this (enforced server-side at /api/admin/users).

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface Props {
  userId: string
  banned: boolean
  isSelf: boolean
}

export function UserActionsClient({ userId, banned, isSelf }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  if (isSelf) return null

  async function toggle() {
    setLoading(true)
    setError(null)
    const action = banned ? 'unban' : 'ban'
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: banned ? '{}' : JSON.stringify({ reason: 'Banned by admin' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="shrink-0 flex flex-col items-end gap-1">
      <Button
        variant={banned ? 'outline' : 'ghost'}
        size="sm"
        onClick={toggle}
        disabled={loading}
        className="text-xs h-7"
      >
        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : banned ? 'Unban' : 'Ban'}
      </Button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}
