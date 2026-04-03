'use client'

// Row actions for a single pack: approve / enable / disable / edit / delete.
// The edit dialog adapts its fields based on the pack's capability_type.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Pencil, Trash2, GitBranch } from 'lucide-react'
import { Button }   from '@/components/ui/button'
import { Input }    from '@/components/ui/input'
import { Label }    from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  skillId:        string
  name:           string
  author:         string | null
  version:        string | null
  sourceRef:      string | null
  sourceUrl:      string | null
  tags:           string[]
  config:         Record<string, unknown>
  enabled:        boolean
  scanStatus:     string
  approvedBy:     string | null
  capabilityType: string | null
}

const TYPE_LABEL: Record<string, string> = {
  domain_pack:    'Domain Pack',
  mcp_skill:      'MCP Skill',
  prompt_only:    'Prompt',
  harmoven_agent: 'Agent',
  js_ts_plugin:   'JS/TS Plugin',
  slash_command:  'Slash Command',
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SkillActionsClient({
  skillId, name, author, version, sourceRef, sourceUrl, tags, config,
  enabled, scanStatus, approvedBy, capabilityType,
}: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)

  // ── Edit dialog ────────────────────────────────────────────────────────────
  const [editOpen,      setEditOpen]      = useState(false)
  const [editName,      setEditName]      = useState(name)
  const [editAuthor,    setEditAuthor]    = useState(author ?? '')
  const [editVersion,   setEditVersion]   = useState(version ?? '')
  const [editSourceRef, setEditSourceRef] = useState(sourceRef ?? '')
  const [editTags,      setEditTags]      = useState(tags.join(', '))
  const [editMcpCmd,    setEditMcpCmd]    = useState(
    typeof config.command === 'string' ? config.command : '',
  )
  const [editConfig,    setEditConfig]    = useState(
    Object.keys(config).length ? JSON.stringify(config, null, 2) : '',
  )
  const [editError, setEditError] = useState<string | null>(null)

  // ── Delete confirm ─────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false)

  const busy = loading !== null
  const ct   = capabilityType ?? ''

  // ── Helpers ───────────────────────────────────────────────────────────────

  function resetEditState() {
    setEditName(name)
    setEditAuthor(author ?? '')
    setEditVersion(version ?? '')
    setEditSourceRef(sourceRef ?? '')
    setEditTags(tags.join(', '))
    setEditMcpCmd(typeof config.command === 'string' ? config.command : '')
    setEditConfig(Object.keys(config).length ? JSON.stringify(config, null, 2) : '')
    setEditError(null)
  }

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

    const body: Record<string, unknown> = { name: editName.trim() }

    const parsedTags = editTags.split(',').map((t) => t.trim()).filter(Boolean)
    body.tags = parsedTags

    if (editAuthor.trim()) body.author = editAuthor.trim()
    if (editVersion.trim()) body.version = editVersion.trim()

    if (ct === 'mcp_skill') {
      if (editConfig.trim()) {
        try { body.config = JSON.parse(editConfig) }
        catch { setEditError('Config is not valid JSON'); return }
      } else if (editMcpCmd.trim()) {
        body.mcp_command = editMcpCmd.trim()
      }
    } else if (ct === 'js_ts_plugin') {
      if (editConfig.trim()) {
        try { body.config = JSON.parse(editConfig) }
        catch { setEditError('Config is not valid JSON'); return }
      }
    } else {
      if (editSourceRef.trim()) body.source_ref = editSourceRef.trim()
    }

    setLoading('edit')
    try {
      const res = await fetch(`/api/admin/integrations/${skillId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const data = await res.json() as { error?: unknown }
      if (!res.ok) {
        setEditError(typeof data.error === 'string' ? data.error : 'Save failed')
        return
      }
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

  const typeLabel = ct ? (TYPE_LABEL[ct] ?? ct) : 'pack'

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
            title={!approvedBy ? 'Must be approved before enabling' : undefined}>
            {loading === 'enable' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Enable'}
          </Button>
        )}

        {/* Edit */}
        <Button size="sm" variant="ghost" disabled={busy}
          onClick={() => { resetEditState(); setEditOpen(true) }}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>

        {/* Delete */}
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="destructive" disabled={loading === 'delete'}
              onClick={handleDelete}>
              {loading === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Confirm'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy}
            onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        )}
      </div>

      {/* ── Edit dialog ─────────────────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(v) => { if (!v) setEditError(null); setEditOpen(v) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit {typeLabel}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4 pt-2">

            {/* Name — always */}
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" required autoFocus
                value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>

            {/* MCP command + full config — mcp_skill only */}
            {ct === 'mcp_skill' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-mcp-cmd">
                    MCP command
                    <span className="ml-1 text-xs text-muted-foreground">(npx / node / …)</span>
                  </Label>
                  <Input id="edit-mcp-cmd" className="font-mono text-xs"
                    placeholder="npx @modelcontextprotocol/server-slack"
                    value={editMcpCmd} onChange={(e) => setEditMcpCmd(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-config">
                    Full config JSON
                    <span className="ml-1 text-xs text-muted-foreground">(overrides command above)</span>
                  </Label>
                  <Textarea id="edit-config" rows={5} className="font-mono text-xs"
                    placeholder={'{\n  "command": "npx",\n  "args": ["@pkg/server"],\n  "env": { "TOKEN": "…" }\n}'}
                    value={editConfig} onChange={(e) => setEditConfig(e.target.value)} />
                </div>
              </>
            )}

            {/* JS/TS plugin config */}
            {ct === 'js_ts_plugin' && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-plugin-config">
                  Config JSON
                  <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
                </Label>
                <Textarea id="edit-plugin-config" rows={4} className="font-mono text-xs"
                  value={editConfig} onChange={(e) => setEditConfig(e.target.value)} />
              </div>
            )}

            {/* Branch / tag / commit ref — domain_pack, harmoven_agent, prompt_only */}
            {(ct === 'domain_pack' || ct === 'harmoven_agent' || ct === 'prompt_only') && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-source-ref" className="flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                  Branch / tag / commit ref
                </Label>
                <Input id="edit-source-ref" className="font-mono text-xs"
                  placeholder="main, v1.2.3, abc1234"
                  value={editSourceRef} onChange={(e) => setEditSourceRef(e.target.value)} />
                {sourceUrl && (
                  <p className="text-[10px] text-muted-foreground truncate">
                    {sourceUrl}
                  </p>
                )}
              </div>
            )}

            {/* Version — all except MCP */}
            {ct !== 'mcp_skill' && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-version">Version</Label>
                <Input id="edit-version" className="font-mono text-xs"
                  placeholder="1.0.0, main, …"
                  value={editVersion} onChange={(e) => setEditVersion(e.target.value)} />
              </div>
            )}

            {/* Author — not for MCP / JS plugin */}
            {ct !== 'mcp_skill' && ct !== 'js_ts_plugin' && (
              <div className="space-y-1.5">
                <Label htmlFor="edit-author">Author</Label>
                <Input id="edit-author" className="text-xs"
                  value={editAuthor} onChange={(e) => setEditAuthor(e.target.value)} />
              </div>
            )}

            {/* Tags — always */}
            <div className="space-y-1.5">
              <Label htmlFor="edit-tags">
                Tags
                <span className="ml-1 text-xs text-muted-foreground">(comma-separated)</span>
              </Label>
              <Input id="edit-tags" className="text-xs"
                placeholder="finance, analysis, reporting"
                value={editTags} onChange={(e) => setEditTags(e.target.value)} />
            </div>

            {editError && <p className="text-sm text-destructive">{editError}</p>}

            <DialogFooter>
              <Button type="button" variant="ghost"
                onClick={() => setEditOpen(false)} disabled={loading === 'edit'}>
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

import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

interface Props {
  skillId:        string
  name:           string
  config:         Record<string, unknown>
  enabled:        boolean
  scanStatus:     string
  approvedBy:     string | null
  capabilityType: string | null
}

const TYPE_LABEL: Record<string, string> = {
  domain_pack:    'Domain Pack',
  mcp_skill:      'MCP Skill',
  prompt_only:    'Prompt',
  harmoven_agent: 'Agent',
  js_ts_plugin:   'JS/TS Plugin',
  slash_command:  'Slash Command',
}

export function SkillActionsClient({ skillId, name, config, enabled, scanStatus, approvedBy, capabilityType }: Props) {
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
            <DialogTitle>
              Edit {capabilityType ? (TYPE_LABEL[capabilityType] ?? capabilityType) : 'pack'}
            </DialogTitle>
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

