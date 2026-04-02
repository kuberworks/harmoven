'use client'
// app/(app)/admin/marketplace/admin-marketplace-client.tsx
// Client component for the Admin → Marketplace settings page.
// Renders three sub-sections: Git URL Whitelist, Registry Feeds, Git Provider Tokens.
// All mutations are through fetch() calls to the API routes.

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Plus,
  Trash2,
  TestTube2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  GitBranch,
  Store,
  Key,
  Activity,
} from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhitelistEntry {
  id:         string
  label:      string
  pattern:    string
  description: string | null
  is_builtin: boolean
  enabled:    boolean
  created_at: string
}

interface Registry {
  id:                string
  label:             string
  feed_url:          string
  has_auth:          boolean
  is_builtin:        boolean
  enabled:           boolean
  last_fetched_at:   string | null
  last_fetch_status: string | null
  created_at:        string
}

interface GitProviderToken {
  id:            string
  label:         string
  host_pattern:  string
  has_token:     boolean
  enabled:       boolean
  expires_at:    string | null
  expiry_status: 'valid' | 'expiring_soon' | 'expired'
  created_at:    string
}

interface CronHealth {
  health:                  string
  last_run_at:             string | null
  last_scheduled_run_at:   string | null
  last_run_status:         string | null
  last_run_summary:        { checked: number; updated: number; errors: number } | null
  pending_updates_count:   number
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface AdminMarketplaceClientProps {
  initialWhitelist:  WhitelistEntry[]
  initialRegistries: Registry[]
  initialTokens:     GitProviderToken[]
  cronHealth:        CronHealth
}

// ─── Whitelist Section ────────────────────────────────────────────────────────

function WhitelistSection({ initial }: { initial: WhitelistEntry[] }) {
  const { toast } = useToast()
  const [entries, setEntries] = useState(initial)
  const [showAdd, setShowAdd] = useState(false)
  const [label, setLabel] = useState('')
  const [pattern, setPattern] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<WhitelistEntry | null>(null)

  const reload = useCallback(async () => {
    const res = await fetch('/api/admin/marketplace/git-whitelist?size=100')
    if (res.ok) {
      const data = await res.json() as { data: WhitelistEntry[] }
      setEntries(data.data)
    }
  }, [])

  const handleAdd = async () => {
    if (!label || !pattern) return
    setSaving(true)
    try {
      const res = await fetch('/api/admin/marketplace/git-whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, pattern, description: description || undefined }),
      })
      if (!res.ok) {
        const err = await res.json() as { error: string }
        toast({ title: 'Erreur', description: err.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Entrée ajoutée', description: `${pattern} ajouté à la whitelist.` })
      setLabel(''); setPattern(''); setDescription(''); setShowAdd(false)
      await reload()
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (entry: WhitelistEntry) => {
    const res = await fetch(`/api/admin/marketplace/git-whitelist/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !entry.enabled }),
    })
    if (res.ok) {
      setEntries((prev) => prev.map((e) => e.id === entry.id ? { ...e, enabled: !e.enabled } : e))
    }
  }

  const handleDelete = async (entry: WhitelistEntry) => {
    const res = await fetch(`/api/admin/marketplace/git-whitelist/${entry.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: 'Entrée supprimée' })
      setEntries((prev) => prev.filter((e) => e.id !== entry.id))
    } else {
      const err = await res.json() as { error: string }
      toast({ title: 'Erreur', description: err.error, variant: 'destructive' })
    }
    setDeleteTarget(null)
  }

  return (
    <Card className="rounded-xl border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <GitBranch className="h-4 w-4 text-amber-500" />
              Git URL Whitelist
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Patterns d&apos;hôtes autorisés pour les imports Git. Supports hostname et glob (*.example.com).
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="h-8 gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Ajouter
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow className="border-border/50">
              <TableHead className="text-xs py-2">Label</TableHead>
              <TableHead className="text-xs py-2">Pattern</TableHead>
              <TableHead className="text-xs py-2 w-20">Activé</TableHead>
              <TableHead className="text-xs py-2 w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id} className="border-border/30">
                <TableCell className="py-2 text-sm">
                  {entry.label}
                  {entry.is_builtin && <Badge variant="outline" className="ml-2 text-xs py-0">builtin</Badge>}
                </TableCell>
                <TableCell className="py-2 font-mono text-xs text-muted-foreground">{entry.pattern}</TableCell>
                <TableCell className="py-2">
                  <Switch
                    checked={entry.enabled}
                    onCheckedChange={() => handleToggle(entry)}
                    disabled={entry.is_builtin}
                    aria-label={`Toggle ${entry.pattern}`}
                  />
                </TableCell>
                <TableCell className="py-2 text-right">
                  {!entry.is_builtin && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-red-500"
                      onClick={() => setDeleteTarget(entry)}
                      aria-label={`Supprimer ${entry.pattern}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      {/* Add dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ajouter un pattern Git</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GitHub Public" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Pattern (hostname ou glob)</Label>
              <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="github.com ou *.internal.corp" className="h-9 font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description (optionnel)</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description..." className="h-9" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Annuler</Button>
            <Button size="sm" onClick={handleAdd} disabled={saving || !label || !pattern}>
              {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Ajouter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open: boolean) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Supprimer ce pattern ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{deleteTarget?.pattern}</span> sera supprimé de la whitelist.
            Les imports depuis cet hôte seront bloqués.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Annuler</Button>
            <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={() => deleteTarget && handleDelete(deleteTarget)}>Supprimer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ─── Registry Section ─────────────────────────────────────────────────────────

function RegistriesSection({ initial }: { initial: Registry[] }) {
  const { toast } = useToast()
  const [registries, setRegistries] = useState(initial)
  const [showAdd, setShowAdd] = useState(false)
  const [label, setLabel] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [authHeader, setAuthHeader] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Registry | null>(null)

  const reload = useCallback(async () => {
    const res = await fetch('/api/admin/marketplace/registries?size=100')
    if (res.ok) {
      const data = await res.json() as { data: Registry[] }
      setRegistries(data.data)
    }
  }, [])

  const handleAdd = async () => {
    if (!label || !feedUrl) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = { label, feed_url: feedUrl }
      if (authHeader) body.auth_header = authHeader
      const res = await fetch('/api/admin/marketplace/registries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json() as { error: string }
        toast({ title: 'Erreur', description: err.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Registry ajoutée' })
      setLabel(''); setFeedUrl(''); setAuthHeader(''); setShowAdd(false)
      await reload()
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (reg: Registry) => {
    await fetch(`/api/admin/marketplace/registries/${reg.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !reg.enabled }),
    })
    setRegistries((prev) => prev.map((r) => r.id === reg.id ? { ...r, enabled: !r.enabled } : r))
  }

  const handleTest = async (reg: Registry) => {
    setTesting(reg.id)
    try {
      const res = await fetch(`/api/admin/marketplace/registries/${reg.id}/test`, { method: 'POST' })
      const data = await res.json() as { plugin_count?: number; error?: string; message?: string }
      if (res.ok) {
        toast({ title: 'Test réussi', description: `${data.plugin_count} plugin(s) trouvé(s).` })
      } else {
        toast({ title: 'Test échoué', description: data.message ?? data.error, variant: 'destructive' })
      }
      await reload()
    } finally {
      setTesting(null)
    }
  }

  const handleDelete = async (reg: Registry) => {
    const res = await fetch(`/api/admin/marketplace/registries/${reg.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: 'Registry supprimée' })
      setRegistries((prev) => prev.filter((r) => r.id !== reg.id))
    } else {
      const err = await res.json() as { error: string }
      toast({ title: 'Erreur', description: err.error, variant: 'destructive' })
    }
    setDeleteTarget(null)
  }

  return (
    <Card className="rounded-xl border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Store className="h-4 w-4 text-amber-500" />
              Registry Feeds
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Sources distantes de plugins (JSON/YAML). Utilisées par l&apos;onglet Browse du marketplace.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="h-8 gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Ajouter
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow className="border-border/50">
              <TableHead className="text-xs py-2">Label</TableHead>
              <TableHead className="text-xs py-2">URL</TableHead>
              <TableHead className="text-xs py-2 w-24">Statut</TableHead>
              <TableHead className="text-xs py-2 w-20">Activé</TableHead>
              <TableHead className="text-xs py-2 w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {registries.map((reg) => (
              <TableRow key={reg.id} className="border-border/30">
                <TableCell className="py-2 text-sm">
                  {reg.label}
                  {reg.is_builtin && <Badge variant="outline" className="ml-2 text-xs py-0">builtin</Badge>}
                  {reg.has_auth && <Badge variant="secondary" className="ml-1 text-xs py-0">auth</Badge>}
                </TableCell>
                <TableCell className="py-2 font-mono text-xs text-muted-foreground max-w-[200px] truncate">{reg.feed_url}</TableCell>
                <TableCell className="py-2">
                  {reg.last_fetch_status === 'ok'
                    ? <Badge variant="outline" className="text-green-400 border-green-800 text-xs py-0">ok</Badge>
                    : reg.last_fetch_status
                    ? <Badge variant="destructive" className="text-xs py-0">erreur</Badge>
                    : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="py-2">
                  <Switch
                    checked={reg.enabled}
                    onCheckedChange={() => handleToggle(reg)}
                    disabled={reg.is_builtin}
                    aria-label={`Toggle ${reg.label}`}
                  />
                </TableCell>
                <TableCell className="py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => handleTest(reg)}
                      disabled={testing === reg.id}
                      aria-label={`Tester ${reg.label}`}
                    >
                      {testing === reg.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TestTube2 className="h-3.5 w-3.5" />}
                    </Button>
                    {!reg.is_builtin && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-red-500"
                        onClick={() => setDeleteTarget(reg)}
                        aria-label={`Supprimer ${reg.label}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ajouter une registry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My Registry" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Feed URL (HTTPS)</Label>
              <Input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="https://example.com/index.json" className="h-9 font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Auth header (optionnel)</Label>
              <Input value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="Bearer ..." type="password" className="h-9 font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Stocké chiffré (AES-256-GCM).</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Annuler</Button>
            <Button size="sm" onClick={handleAdd} disabled={saving || !label || !feedUrl}>
              {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Ajouter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open: boolean) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Supprimer cette registry ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{deleteTarget?.label} — {deleteTarget?.feed_url}</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Annuler</Button>
            <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={() => deleteTarget && handleDelete(deleteTarget)}>Supprimer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ─── Git Tokens Section ───────────────────────────────────────────────────────

function GitTokensSection({ initial }: { initial: GitProviderToken[] }) {
  const { toast } = useToast()
  const [tokens, setTokens] = useState(initial)
  const [showAdd, setShowAdd] = useState(false)
  const [label, setLabel] = useState('')
  const [hostPattern, setHostPattern] = useState('')
  const [tokenValue, setTokenValue] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<GitProviderToken | null>(null)

  const reload = useCallback(async () => {
    const res = await fetch('/api/admin/marketplace/git-provider-tokens?size=100')
    if (res.ok) {
      const data = await res.json() as { data: GitProviderToken[] }
      setTokens(data.data)
    }
  }, [])

  const handleAdd = async () => {
    if (!label || !hostPattern || !tokenValue) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = { label, host_pattern: hostPattern, token: tokenValue }
      if (expiresAt) body.expires_at = new Date(expiresAt).toISOString()
      const res = await fetch('/api/admin/marketplace/git-provider-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json() as { error: string }
        toast({ title: 'Erreur', description: err.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Token ajouté' })
      setLabel(''); setHostPattern(''); setTokenValue(''); setExpiresAt(''); setShowAdd(false)
      await reload()
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (tok: GitProviderToken) => {
    setTesting(tok.id)
    try {
      const res = await fetch(`/api/admin/marketplace/git-provider-tokens/${tok.id}/test`, { method: 'POST' })
      const data = await res.json() as { http_status?: number; error?: string; message?: string }
      if (res.ok && data.http_status === 200) {
        toast({ title: 'Token valide', description: `HTTP ${data.http_status}` })
      } else {
        toast({ title: 'Test échoué', description: data.message ?? `HTTP ${data.http_status ?? 'error'}`, variant: 'destructive' })
      }
    } finally {
      setTesting(null)
    }
  }

  const handleDelete = async (tok: GitProviderToken) => {
    const res = await fetch(`/api/admin/marketplace/git-provider-tokens/${tok.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: 'Token supprimé' })
      setTokens((prev) => prev.filter((t) => t.id !== tok.id))
    }
    setDeleteTarget(null)
  }

  const expiryBadge = (tok: GitProviderToken) => {
    if (!tok.expires_at) return null
    if (tok.expiry_status === 'expired') return <Badge variant="destructive" className="text-xs py-0 ml-1">expiré</Badge>
    if (tok.expiry_status === 'expiring_soon') return <Badge className="text-xs py-0 ml-1 bg-amber-500/20 text-amber-400 border-amber-700">expire bientôt</Badge>
    return null
  }

  return (
    <Card className="rounded-xl border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Key className="h-4 w-4 text-amber-500" />
              Tokens Git Provider
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Tokens d&apos;accès pour les dépôts Git privés. Stockés chiffrés, jamais renvoyés via l&apos;API.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="h-8 gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Ajouter
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <Table>
          <TableHeader>
            <TableRow className="border-border/50">
              <TableHead className="text-xs py-2">Label</TableHead>
              <TableHead className="text-xs py-2">Host pattern</TableHead>
              <TableHead className="text-xs py-2 w-24">Expiration</TableHead>
              <TableHead className="text-xs py-2 w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((tok) => (
              <TableRow key={tok.id} className="border-border/30">
                <TableCell className="py-2 text-sm">
                  {tok.label}
                  {expiryBadge(tok)}
                </TableCell>
                <TableCell className="py-2 font-mono text-xs text-muted-foreground">{tok.host_pattern}</TableCell>
                <TableCell className="py-2 text-xs text-muted-foreground">
                  {tok.expires_at ? new Date(tok.expires_at).toLocaleDateString('fr-FR') : '—'}
                </TableCell>
                <TableCell className="py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => handleTest(tok)}
                      disabled={testing === tok.id}
                      aria-label={`Tester ${tok.label}`}
                    >
                      {testing === tok.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <TestTube2 className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-red-500"
                      onClick={() => setDeleteTarget(tok)}
                      aria-label={`Supprimer ${tok.label}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                  Aucun token configuré. Les dépôts publics sont accessibles sans authentification.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ajouter un token Git</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GitHub (ACME org)" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Host pattern</Label>
              <Input value={hostPattern} onChange={(e) => setHostPattern(e.target.value)} placeholder="github.com" className="h-9 font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Token (Bearer ou user:password)</Label>
              <Input value={tokenValue} onChange={(e) => setTokenValue(e.target.value)} type="password" placeholder="ghp_..." className="h-9 font-mono text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Date d&apos;expiration (optionnel)</Label>
              <Input value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} type="date" className="h-9" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Annuler</Button>
            <Button size="sm" onClick={handleAdd} disabled={saving || !label || !hostPattern || !tokenValue}>
              {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Ajouter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open: boolean) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Supprimer ce token ?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{deleteTarget?.label} — {deleteTarget?.host_pattern}</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Annuler</Button>
            <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={() => deleteTarget && handleDelete(deleteTarget)}>Supprimer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ─── Cron Status Section ──────────────────────────────────────────────────────

function CronStatusSection({ initial }: { initial: CronHealth }) {
  const { toast } = useToast()
  const [health, setHealth] = useState(initial)
  const [running, setRunning] = useState(false)

  const reload = useCallback(async () => {
    const res = await fetch('/api/admin/marketplace/cron-health')
    if (res.ok) setHealth(await res.json() as CronHealth)
  }, [])

  const handleLaunchNow = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/internal/run-update-checks', { method: 'POST' })
      const data = await res.json() as { checked?: number; updated?: number; error?: string }
      if (res.ok) {
        toast({
          title: 'Vérification terminée',
          description: `${data.checked} skills vérifiés, ${data.updated} mises à jour détectées.`,
        })
      } else {
        toast({ title: 'Échec du déclenchement', description: data.error, variant: 'destructive' })
      }
      await reload()
    } finally {
      setRunning(false)
    }
  }

  const healthColor = {
    OK: 'text-green-400',
    UPDATES_AVAILABLE: 'text-amber-400',
    STALE: 'text-red-400',
    DELAYED: 'text-amber-400',
    ERROR: 'text-red-400',
    NOT_CONFIGURED: 'text-muted-foreground',
  }[health.health] ?? 'text-muted-foreground'

  return (
    <Card className="rounded-xl border-border/50 bg-card/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-amber-500" />
            Cron — Vérification automatique des mises à jour
          </CardTitle>
          <Button size="sm" variant="outline" onClick={handleLaunchNow} disabled={running} className="h-8 gap-1.5">
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Lancer maintenant
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${healthColor}`}>{health.health}</span>
          {health.pending_updates_count > 0 && (
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-700 text-xs">
              {health.pending_updates_count} mise(s) à jour en attente
            </Badge>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-muted-foreground">Dernier run :</span>{' '}
            <span>{health.last_run_at ? new Date(health.last_run_at).toLocaleString('fr-FR') : '—'}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Dernier run planifié :</span>{' '}
            <span>{health.last_scheduled_run_at ? new Date(health.last_scheduled_run_at).toLocaleString('fr-FR') : '—'}</span>
          </div>
          {health.last_run_summary && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Résumé :</span>{' '}
              <span>{health.last_run_summary.checked} vérifiés · {health.last_run_summary.updated} changements · {health.last_run_summary.errors} erreurs</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AdminMarketplaceClient({
  initialWhitelist,
  initialRegistries,
  initialTokens,
  cronHealth,
}: AdminMarketplaceClientProps) {
  return (
    <Tabs defaultValue="whitelist" className="space-y-4">
      <TabsList className="h-9">
        <TabsTrigger value="whitelist" className="text-xs h-7">Git Whitelist</TabsTrigger>
        <TabsTrigger value="registries" className="text-xs h-7">Registries</TabsTrigger>
        <TabsTrigger value="tokens" className="text-xs h-7">Tokens Git</TabsTrigger>
        <TabsTrigger value="cron" className="text-xs h-7">Cron</TabsTrigger>
      </TabsList>

      <TabsContent value="whitelist" className="space-y-0">
        <WhitelistSection initial={initialWhitelist} />
      </TabsContent>

      <TabsContent value="registries" className="space-y-0">
        <RegistriesSection initial={initialRegistries} />
      </TabsContent>

      <TabsContent value="tokens" className="space-y-0">
        <GitTokensSection initial={initialTokens} />
      </TabsContent>

      <TabsContent value="cron" className="space-y-0">
        <CronStatusSection initial={cronHealth} />
      </TabsContent>
    </Tabs>
  )
}
