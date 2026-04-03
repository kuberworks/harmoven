'use client'

// Row actions for a single integration: approve / enable / disable / edit / delete.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

interface Props {
  skillId:       string
  name:          string
  config:        Record<string, unknown>
  enabled:       boolean
  scanStatus:    string
  approvedBy:    string | null
}

export function SkillActionsClient({ skillId, name, config, enabled, scanStatus, approvedBy }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)

  // ── Edit dialog state ────────────────────────────────────────────────────
  const [editOpen, setEditOpen]     = useState(false)
  const [editName, setEditName]     = useState(name)
  const [editConfig, setEditConfig] = useState(
    Object.keys(config).length ? JSON.stringify(config, null, 2) : '',
  )
  const [editError, setEditError]   = useState<string | null>(null)

  // ── Delete confirm state ─────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false)

  const busy = loading !== null

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function patch(body: Record<string, unknown>, action: string) {
    setLoading(action)
    try {
      const res = await fetch(`/api/admin/integrations/${skillId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await res.text())
      router.refresh()
    } finally {
      setLoading(null)
    }
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault()
    setEditError(null)
    let parsedConfig: Record<string, unknown> | undefined
    if (editConfig.trim()) {
      try { parsedConfig = JSON.parse(editConfig) } catch {
        setEditError('Config is not valid JSON'); return
      }
    }
    setLoading('edit')
    try {
      const body: Record<string, unknown> = { name: editName.trim() }
      if (parsedConfig !== undefined) body.config = parsedConfig
      const res = await fetch(`/api/admin/integrations/${skillId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json() as { error?: unknown }
      if (!res.ok) { setEditError(typeof data.error === 'string' ? data.error : 'Save failed'); return }
      setEditOpen(false)
      router.refresh()
    } finally {
      setLoading(null)
    }
  }

  async function handleDelete() {
    setLoading('delete')
    try {
      await fetch(`/api/admin/integrations/${skillId}`, { method: 'DELETE' })
      router.refresh()
    } finally {
      setLoading(null)
      setConfirmDelete(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 shrink-0">
        {/* Approve */}
        {scanStatus === 'passed' && !approvedBy && (
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => patch({ approved: true }, 'approve')}>
            {loading === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Approve'}
          </Button>
        )}

        {/* Enable / Disable */}
        {enabled ? (
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => patch({ enabled: false }, 'disable')}>
            {loading === 'disable' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Disable'}
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !approvedBy}
            onClick={() => patch({ enabled: true }, 'enable')}
            title={!approvedBy ? 'Integration must be approved before enabling' : undefined}>
            {loading === 'enable' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Enable'}
          </Button>
        )}

        {/* Edit */}
        <Button size="sm" variant="ghost" disabled={busy}
          onClick={() => { setEditName(name); setEditConfig(Object.keys(config).length ? JSON.stringify(config, null, 2) : ''); setEditError(null); setEditOpen(true) }}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>

        {/* Delete — inline confirm */}
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="destructive" disabled={loading === 'delete'}
              onClick={handleDelete}>
              {loading === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Confirm'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy}
            onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        )}
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={(v) => { if (!v) setEditError(null); setEditOpen(v) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit integration</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                required
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-config">
                Config <span className="text-muted-foreground text-xs">(JSON, optional)</span>
              </Label>
              <Textarea
                id="edit-config"
                value={editConfig}
                onChange={(e) => setEditConfig(e.target.value)}
                placeholder={'{ "command": "npx", "args": ["@modelcontextprotocol/server-slack"] }'}
                rows={5}
                className="font-mono text-xs"
              />
            </div>
            {editError && <p className="text-sm text-destructive">{editError}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditOpen(false)} disabled={loading === 'edit'}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading === 'edit' || !editName.trim()}>
                {loading === 'edit' && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

