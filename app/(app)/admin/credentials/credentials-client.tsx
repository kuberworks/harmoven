'use client'

// app/(app)/admin/credentials/credentials-client.tsx
// Write-only credential vault — create, list (names only), update value, delete.
// Values are NEVER shown after creation — only the name and metadata.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ShieldCheck, Plus, Trash2, RefreshCw, Loader2, Lock, EyeOff } from 'lucide-react'

type CredentialType = 'api_key' | 'oauth_token' | 'basic_auth' | 'bearer'

export interface CredentialRow {
  id: string
  name: string
  type: CredentialType
  projectName: string
  projectId: string
  hostPattern: string
  lastUsedAt: string | null
  rotatedAt: string | null
  createdAt: string
}

interface Props {
  credentials: CredentialRow[]
}

const TYPE_LABELS: Record<CredentialType, string> = {
  api_key:    'API Key',
  oauth_token:'OAuth Token',
  basic_auth: 'Basic Auth',
  bearer:     'Bearer Token',
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function CredentialsClient({ credentials: initialCreds }: Props) {
  const { toast } = useToast()
  const router = useRouter()

  const [creds, setCreds]             = useState(initialCreds)
  const [createOpen, setCreateOpen]   = useState(false)
  const [updateTarget, setUpdateTarget] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [saving, setSaving]           = useState(false)

  // Create form state
  const [formName, setFormName]           = useState('')
  const [formValue, setFormValue]         = useState('')
  const [formType, setFormType]           = useState<CredentialType>('api_key')
  const [formInjectAs, setFormInjectAs]   = useState('')
  const [formInjectFmt, setFormInjectFmt] = useState('Bearer {value}')
  const [formHost, setFormHost]           = useState('')
  const [formProjectId, setFormProjectId] = useState('')

  // Update form
  const [updateValue, setUpdateValue] = useState('')

  function resetForm() {
    setFormName('')
    setFormValue('')
    setFormType('api_key')
    setFormInjectAs('Authorization')
    setFormInjectFmt('Bearer {value}')
    setFormHost('')
    setFormProjectId('')
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/admin/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:         formName.trim(),
          value:        formValue,
          type:         formType,
          inject_as:    formInjectAs.trim() || 'Authorization',
          inject_fmt:   formInjectFmt.trim() || 'Bearer {value}',
          host_pattern: formHost.trim(),
          project_id:   formProjectId || undefined,
          tool_scope:   [],
        }),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => 'Failed to create credential')
        throw new Error(msg)
      }
      const data = await res.json()
      setCreds((prev) => [
        {
          id:          data.credential?.id ?? Date.now().toString(),
          name:        formName.trim(),
          type:        formType,
          projectName: '',
          projectId:   formProjectId,
          hostPattern: formHost.trim(),
          lastUsedAt:  null,
          rotatedAt:   null,
          createdAt:   new Date().toISOString(),
        },
        ...prev,
      ])
      toast({ title: 'Credential created', description: 'Value encrypted and stored. It will not be shown again.' })
      resetForm()
      setCreateOpen(false)
    } catch (err) {
      toast({
        title: 'Failed to create credential',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!updateTarget) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/credentials/${updateTarget}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: updateValue }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setCreds((prev) =>
        prev.map((c) =>
          c.id === updateTarget ? { ...c, rotatedAt: new Date().toISOString() } : c,
        ),
      )
      toast({ title: 'Credential value updated' })
      setUpdateValue('')
      setUpdateTarget(null)
    } catch {
      toast({ title: 'Failed to update credential', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/credentials/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setCreds((prev) => prev.filter((c) => c.id !== id))
      toast({ title: 'Credential deleted' })
      setDeleteTarget(null)
    } catch {
      toast({ title: 'Failed to delete credential', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 animate-stagger">
      {/* Security note */}
      <Alert variant="info">
        <ShieldCheck className="h-4 w-4" aria-hidden />
        <AlertTitle>Write-only vault</AlertTitle>
        <AlertDescription>
          Credential values are encrypted with AES-256-GCM and never returned by the API.
          Only names and metadata are visible here.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
              Credentials
              <Badge variant="secondary" className="text-xs">{creds.length}</Badge>
            </span>
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add credential
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {creds.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <EyeOff className="h-7 w-7 text-muted-foreground/30" aria-hidden />
              <p className="text-sm text-muted-foreground">No credentials stored yet.</p>
            </div>
          ) : (
            <ul className="divide-y divide-surface-border">
              {creds.map((c) => (
                <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-sm font-mono font-medium text-foreground">{c.name}</code>
                      <Badge variant="secondary" className="text-xs">{TYPE_LABELS[c.type] ?? c.type}</Badge>
                      {c.hostPattern && (
                        <span className="text-xs text-muted-foreground font-mono">{c.hostPattern}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      <span>Created {formatDate(c.createdAt)}</span>
                      {c.rotatedAt && <span>· Rotated {formatDate(c.rotatedAt)}</span>}
                      <span>· Last used: {formatDate(c.lastUsedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                      onClick={() => setUpdateTarget(c.id)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Rotate
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      onClick={() => setDeleteTarget(c.id)}
                      aria-label={`Delete ${c.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-amber-400" />
              Add credential
            </DialogTitle>
            <DialogDescription>
              The value will be encrypted immediately and never shown again.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cred-name">Name</Label>
                <Input
                  id="cred-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="STRIPE_API_KEY"
                  className="font-mono text-sm"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cred-type">Type</Label>
                <Select value={formType} onValueChange={(v) => setFormType(v as CredentialType)}>
                  <SelectTrigger id="cred-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cred-value">Value</Label>
              <Input
                id="cred-value"
                type="password"
                value={formValue}
                onChange={(e) => setFormValue(e.target.value)}
                placeholder="sk-live-…"
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cred-host">Host pattern</Label>
              <Input
                id="cred-host"
                value={formHost}
                onChange={(e) => setFormHost(e.target.value)}
                placeholder="api.stripe.com"
                className="font-mono text-sm"
                required
              />
              <p className="text-xs text-muted-foreground">Credential injection is scoped to this hostname.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cred-inject-as">Inject as</Label>
                <Input
                  id="cred-inject-as"
                  value={formInjectAs}
                  onChange={(e) => setFormInjectAs(e.target.value)}
                  placeholder="Authorization"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cred-inject-fmt">Format</Label>
                <Input
                  id="cred-inject-fmt"
                  value={formInjectFmt}
                  onChange={(e) => setFormInjectFmt(e.target.value)}
                  placeholder="Bearer {value}"
                  className="font-mono text-sm"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => { resetForm(); setCreateOpen(false) }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving || !formName.trim() || !formValue || !formHost.trim()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Store credential
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Update value dialog */}
      <Dialog open={!!updateTarget} onOpenChange={() => setUpdateTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-amber-400" />
              Rotate credential value
            </DialogTitle>
            <DialogDescription>
              Enter the new value. The old value will be overwritten immediately.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleUpdate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="update-value">New value</Label>
              <Input
                id="update-value"
                type="password"
                value={updateValue}
                onChange={(e) => setUpdateValue(e.target.value)}
                placeholder="New secret value"
                autoComplete="off"
                required
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setUpdateTarget(null)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving || !updateValue}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Update value
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete credential</DialogTitle>
            <DialogDescription>
              {(() => {
                const c = creds.find((x) => x.id === deleteTarget)
                return `Delete ${c?.name ?? 'this credential'}? Any tool using it will fail immediately.`
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              disabled={saving}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
