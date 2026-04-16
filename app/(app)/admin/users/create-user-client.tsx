'use client'

// app/(app)/admin/users/create-user-client.tsx
// "Create user" button + modal form for the admin users page.
// POSTs to /api/admin/users and refreshes the server component on success.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { UserPlus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function CreateUserClient() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'user' as 'user' | 'instance_admin',
  })

  function reset() {
    setForm({ name: '', email: '', password: '', role: 'user' })
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        const msg = typeof data.error === 'string'
          ? data.error
          : res.status === 409 ? 'Email already registered' : `HTTP ${res.status}`
        setError(msg)
        return
      }
      setOpen(false)
      reset()
      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5 text-xs h-8"
        onClick={() => { reset(); setOpen(true) }}
      >
        <UserPlus className="h-3.5 w-3.5" />
        Create user
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); setOpen(v) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create user account</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="cu-name">Full name</Label>
              <Input
                id="cu-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Jane Doe"
                required
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-email">Email</Label>
              <Input
                id="cu-email"
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="jane@example.com"
                required
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-password">Temporary password</Label>
              <Input
                id="cu-password"
                type="password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="Min. 8 characters"
                minLength={8}
                required
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cu-role">Role</Label>
              <Select
                value={form.role}
                onValueChange={(v) => setForm(f => ({ ...f, role: v as 'user' | 'instance_admin' }))}
                disabled={loading}
              >
                <SelectTrigger id="cu-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="instance_admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
