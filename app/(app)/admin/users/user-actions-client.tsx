'use client'

// app/(app)/admin/users/user-actions-client.tsx
// Per-row actions for admin users list: ban/unban, promote/demote, delete.
// Only instance_admin can do this (enforced server-side at /api/admin/users).

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface Props {
  userId: string
  banned: boolean
  role: string
  isLastAdmin: boolean
  isSelf: boolean
}

export function UserActionsClient({ userId, banned, role, isLastAdmin, isSelf }: Props) {
  const [loading, setLoading] = useState<'ban' | 'role' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const router = useRouter()

  if (isSelf) return null

  async function toggleBan() {
    setLoading('ban')
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
      setLoading(null)
    }
  }

  async function toggleRole() {
    setLoading('role')
    setError(null)
    const newRole = role === 'instance_admin' ? 'user' : 'instance_admin'
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`)
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally {
      setLoading(null)
    }
  }

  async function deleteUser() {
    setLoading('delete')
    setError(null)
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`)
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
      setConfirmDelete(false)
    } finally {
      setLoading(null)
    }
  }

  const isAdmin = role === 'instance_admin'
  const busy = loading !== null

  return (
    <div className="shrink-0 flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {/* Promote / Demote */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleRole}
          disabled={busy || (isAdmin && isLastAdmin)}
          title={isAdmin ? 'Demote to user' : 'Promote to admin'}
          className="h-7 w-7 p-0"
        >
          {loading === 'role'
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : isAdmin
              ? <ShieldOff className="h-3.5 w-3.5 text-muted-foreground" />
              : <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          }
        </Button>

        {/* Ban / Unban */}
        <Button
          variant={banned ? 'outline' : 'ghost'}
          size="sm"
          onClick={toggleBan}
          disabled={busy}
          className="text-xs h-7"
        >
          {loading === 'ban' ? <Loader2 className="h-3 w-3 animate-spin" /> : banned ? 'Unban' : 'Ban'}
        </Button>

        {/* Delete */}
        {!confirmDelete ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className="h-7 w-7 p-0 text-red-400 hover:text-red-500 hover:bg-red-500/10"
            title="Delete user"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
              className="text-xs h-7 text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={deleteUser}
              disabled={busy}
              className="text-xs h-7 text-red-400 hover:text-red-500 hover:bg-red-500/10"
            >
              {loading === 'delete' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Confirm'}
            </Button>
          </>
        )}
      </div>
      {error && <p className="text-xs text-red-400 text-right max-w-[200px]">{error}</p>}
    </div>
  )
}

