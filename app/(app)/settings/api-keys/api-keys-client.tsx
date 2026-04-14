'use client'

// app/(app)/settings/api-keys/api-keys-client.tsx
// User-level API key management — create, list, revoke.
// One-time key display after creation.

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/components/ui/use-toast'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Trash2, Copy, Check, Key, Loader2, AlertTriangle } from 'lucide-react'

export interface ApiKeyRow {
  id: string
  name: string
  start: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

interface Props {
  initialKeys: ApiKeyRow[]
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function ApiKeysClient({ initialKeys }: Props) {
  const { toast } = useToast()
  const [keys, setKeys] = useState(initialKeys)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Create dialog state
  const [name, setName]       = useState('')
  const [expiry, setExpiry]   = useState<string>('never')

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      const body: Record<string, unknown> = { name: name.trim() }
      if (expiry !== 'never') {
        const days = parseInt(expiry, 10)
        const exp  = new Date()
        exp.setDate(exp.getDate() + days)
        body.expiresAt = exp.toISOString()
      }
      const res = await fetch('/api/auth/api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setNewKeyValue(data.key ?? data.apiKey ?? null)
      setKeys((prev) => [
        {
          id:          data.id,
          name:        name.trim(),
          start:       (data.key ?? '').slice(0, 8) + '…',
          createdAt:   new Date().toISOString(),
          lastUsedAt:  null,
          expiresAt:   body.expiresAt as string ?? null,
        },
        ...prev,
      ])
      setName('')
      setExpiry('never')
    } catch {
      toast({ title: 'Failed to create API key', variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true)
    try {
      const res = await fetch(`/api/auth/api-key/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setKeys((prev) => prev.filter((k) => k.id !== id))
      toast({ title: 'API key revoked' })
      setDeleteTarget(null)
    } catch {
      toast({ title: 'Failed to revoke key', variant: 'destructive' })
    } finally {
      setDeleting(false)
    }
  }

  async function copyKey() {
    if (!newKeyValue) return
    await navigator.clipboard.writeText(newKeyValue)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-6 animate-stagger">
      {/* One-time display of new key */}
      {newKeyValue && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>Save your API key &mdash; it won&apos;t be shown again</AlertTitle>
          <AlertDescription>
            <div className="flex items-center gap-2 mt-2">
              <code className="flex-1 font-mono text-xs bg-surface-raised border border-surface-border rounded px-2 py-1.5 select-all overflow-auto">
                {newKeyValue}
              </code>
              <Button size="sm" variant="outline" className="h-8 gap-1.5 shrink-0" onClick={copyKey}>
                {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 text-xs text-muted-foreground h-7"
              onClick={() => setNewKeyValue(null)}
            >
              I&apos;ve saved it &mdash; dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Create form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Key className="h-4 w-4 text-muted-foreground" aria-hidden />
            Create API key
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1.5 flex-1 min-w-40">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CI pipeline"
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-1.5 w-36">
              <Label htmlFor="key-expiry">Expiry</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger id="key-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">No expiry</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={creating || !name.trim()} className="gap-1.5">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Key list */}
      <Card>
        <CardContent className="p-0">
          {keys.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Key className="h-7 w-7 text-muted-foreground/30" aria-hidden />
              <p className="text-sm text-muted-foreground">No API keys yet.</p>
            </div>
          ) : (
            <ul className="divide-y divide-surface-border">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground truncate">{k.name}</p>
                      <code className="text-xs font-mono text-muted-foreground">{k.start}</code>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      <span>Created {formatDate(k.createdAt)}</span>
                      <span>·</span>
                      <span>Last used: {formatDate(k.lastUsedAt)}</span>
                      {k.expiresAt && (
                        <>
                          <span>·</span>
                          <span>Expires {formatDate(k.expiresAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 gap-1 shrink-0"
                    onClick={() => setDeleteTarget(k.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Confirm revoke */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              Any application using this key will immediately lose access. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              disabled={deleting}
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
