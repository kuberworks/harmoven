'use client'

// app/(app)/projects/[projectId]/members/members-client.tsx
// Project-level member management — invite, change role, remove.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Users, UserPlus, Trash2, Loader2 } from 'lucide-react'

export interface MemberRow {
  userId: string
  name: string | null
  email: string
  roleName: string
  roleDisplay: string
  joinedAt: string
}

export interface RoleOption {
  id: string
  name: string
  display_name: string
}

interface Props {
  projectId: string
  members: MemberRow[]
  roles: RoleOption[]
  canManage: boolean
  currentUserId: string
}

function initials(name: string | null, email: string): string {
  if (name) return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  return email.slice(0, 2).toUpperCase()
}

export function ProjectMembersClient({ projectId, members: initialMembers, roles, canManage, currentUserId }: Props) {
  const { toast } = useToast()
  const router = useRouter()

  const [members, setMembers]         = useState(initialMembers)
  const [inviteOpen, setInviteOpen]   = useState(false)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [saving, setSaving]           = useState(false)

  // Invite form
  const [email, setEmail]   = useState('')
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '')

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role_id: roleId }),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => 'Failed to invite member')
        throw new Error(msg)
      }
      toast({ title: 'Invitation sent', description: `${email} has been invited.` })
      setEmail('')
      setInviteOpen(false)
      router.refresh()
    } catch (err) {
      toast({
        title: 'Failed to invite',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleRoleChange(userId: string, newRoleId: string) {
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: newRoleId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const newRole = roles.find((r) => r.id === newRoleId)
      setMembers((prev) =>
        prev.map((m) =>
          m.userId === userId
            ? { ...m, roleName: newRole?.name ?? m.roleName, roleDisplay: newRole?.display_name ?? m.roleDisplay }
            : m,
        ),
      )
      toast({ title: 'Role updated' })
    } catch {
      toast({ title: 'Failed to update role', variant: 'destructive' })
    }
  }

  async function handleRemove(userId: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setMembers((prev) => prev.filter((m) => m.userId !== userId))
      toast({ title: 'Member removed' })
      setRemoveTarget(null)
    } catch {
      toast({ title: 'Failed to remove member', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const currentRoleId = (userId: string) => {
    const m = members.find((x) => x.userId === userId)
    return roles.find((r) => r.name === m?.roleName)?.id ?? roles[0]?.id ?? ''
  }

  return (
    <div className="space-y-6 animate-stagger">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
              Members
              <Badge variant="secondary" className="text-xs">{members.length}</Badge>
            </span>
            {canManage && (
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setInviteOpen(true)}>
                <UserPlus className="h-3.5 w-3.5" />
                Invite member
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {members.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Users className="h-7 w-7 text-muted-foreground/30" aria-hidden />
              <p className="text-sm text-muted-foreground">No members yet.</p>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)} className="mt-1">
                  <UserPlus className="h-3.5 w-3.5 mr-1.5" /> Invite first member
                </Button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-surface-border">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarFallback>{initials(m.name, m.email)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{m.name ?? m.email}</p>
                    {m.name && <p className="text-xs text-muted-foreground truncate">{m.email}</p>}
                  </div>
                  {canManage && m.userId !== currentUserId ? (
                    <Select
                      value={currentRoleId(m.userId)}
                      onValueChange={(rid) => handleRoleChange(m.userId, rid)}
                    >
                      <SelectTrigger className="w-36 h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((r) => (
                          <SelectItem key={r.id} value={r.id} className="text-xs">{r.display_name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="secondary" className="text-xs">{m.roleDisplay}</Badge>
                  )}
                  {canManage && m.userId !== currentUserId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10 shrink-0"
                      onClick={() => setRemoveTarget(m.userId)}
                      aria-label={`Remove ${m.name ?? m.email}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-4 w-4" /> Invite member
            </DialogTitle>
            <DialogDescription>
              The user will be added immediately if they have an account, or notified by email.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleInvite} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="inv-email">Email address</Label>
              <Input
                id="inv-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@company.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-role">Role</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.display_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving || !email.trim()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Send invite
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Confirm remove */}
      <Dialog open={!!removeTarget} onOpenChange={() => setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              {(() => {
                const m = members.find((x) => x.userId === removeTarget)
                return `Remove ${m?.name ?? m?.email ?? 'this member'} from the project? They will lose access immediately.`
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => removeTarget && handleRemove(removeTarget)}
              disabled={saving}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
