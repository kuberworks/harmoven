'use client'

// app/(app)/projects/[projectId]/triggers/triggers-client.tsx
// Cron + webhook trigger management for a project.
// Tabs: Cron | Webhook

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useT } from '@/lib/i18n/client'
import {
  Clock, Webhook, Plus, Trash2, Loader2, Copy, Check, Zap,
} from 'lucide-react'

type TriggerType = 'CRON' | 'WEBHOOK' | 'FILE_WATCHER'

export interface TriggerRow {
  id: string
  name: string
  type: TriggerType
  enabled: boolean
  config: Record<string, unknown>
  lastFiredAt: string | null
  runCount: number
  createdAt: string
}

interface Props {
  projectId: string
  triggers: TriggerRow[]
  canManage: boolean
  webhookBase: string
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

function humanizeCron(expr: string): string {
  // Very basic — a real app would use cronstrue
  const parts = expr.split(' ')
  if (parts.length === 5) {
    const [min, hour, , , weekday] = parts
    if (min === '0' && hour !== '*' && weekday === '*') return `Daily at ${hour}:00`
    if (min === '0' && hour === '0' && weekday === '*') return 'Daily at midnight'
    if (weekday !== '*') return `Weekly`
  }
  return expr
}

export function TriggersClient({ projectId, triggers: initialTriggers, canManage, webhookBase }: Props) {
  const { toast } = useToast()
  const t = useT()
  const router = useRouter()

  const [triggers, setTriggers]       = useState(initialTriggers)
  const [createOpen, setCreateOpen]   = useState(false)
  const [createType, setCreateType]   = useState<TriggerType>('CRON')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [saving, setSaving]           = useState(false)
  const [copied, setCopied]           = useState<string | null>(null)

  // Create form
  const [name, setName]       = useState('')
  const [schedule, setSchedule] = useState('0 9 * * *')

  const cronTriggers    = triggers.filter((t) => t.type === 'CRON')
  const webhookTriggers = triggers.filter((t) => t.type === 'WEBHOOK')

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      const res = await fetch(`/api/admin/triggers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTriggers((prev) => prev.map((tr) => (tr.id === id ? { ...tr, enabled } : tr)))
    } catch {
      toast({ title: 'Failed to update trigger', variant: 'destructive' })
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const config: Record<string, unknown> = createType === 'CRON'
        ? { schedule }
        : {}
      const res = await fetch('/api/admin/triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          type: createType,
          name: name.trim(),
          config,
          task_overrides: {},
          supervision: 'auto_deliver_if_approved',
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setTriggers((prev) => [
        {
          id: data.id,
          name: name.trim(),
          type: createType,
          enabled: true,
          config,
          lastFiredAt: null,
          runCount: 0,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ])
      toast({ title: `${createType === 'CRON' ? 'Cron' : 'Webhook'} trigger created` })
      setName('')
      setSchedule('0 9 * * *')
      setCreateOpen(false)
    } catch {
      toast({ title: 'Failed to create trigger', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/triggers/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTriggers((prev) => prev.filter((t) => t.id !== id))
      toast({ title: 'Trigger deleted' })
      setDeleteTarget(null)
    } catch {
      toast({ title: 'Failed to delete trigger', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  function webhookUrl(triggerId: string): string {
    return `${webhookBase}/api/webhooks/${projectId}/${triggerId}`
  }

  async function copyUrl(url: string, id: string) {
    await navigator.clipboard.writeText(url)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  function TriggerCard({ trigger }: { trigger: TriggerRow }) {
    const isCron = trigger.type === 'CRON'
    const schedule = String(trigger.config?.schedule ?? '')
    const url = webhookUrl(trigger.id)

    return (
      <li className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-foreground">{trigger.name}</p>
            {isCron && (
              <code className="text-xs font-mono text-muted-foreground bg-surface-hover rounded px-1.5 py-0.5">
                {humanizeCron(schedule)}
              </code>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <span>Fired {trigger.runCount} times</span>
            <span>·</span>
            <span>Last: {formatDate(trigger.lastFiredAt)}</span>
          </div>
          {!isCron && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <code className="text-xs font-mono text-muted-foreground truncate max-w-48">{url}</code>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs gap-1"
                onClick={() => copyUrl(url, trigger.id)}
              >
                {copied === trigger.id ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canManage && (
            <Switch
              checked={trigger.enabled}
              onCheckedChange={(v) => toggleEnabled(trigger.id, v)}
              aria-label={`Toggle ${trigger.name}`}
            />
          )}
          <Badge variant={trigger.enabled ? 'completed' : 'pending'} className="text-xs">
            {trigger.enabled ? 'Active' : 'Paused'}
          </Badge>
          {canManage && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
              onClick={() => setDeleteTarget(trigger.id)}
              aria-label={`Delete ${trigger.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </li>
    )
  }

  function EmptyTriggers({ type }: { type: TriggerType }) {
    const Icon = type === 'CRON' ? Clock : Webhook
    const label = type === 'CRON' ? 'cron' : 'webhook'
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Icon className="h-7 w-7 text-muted-foreground/30" aria-hidden />
        <p className="text-sm text-muted-foreground">No {label} triggers yet.</p>
        {canManage && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setCreateType(type); setCreateOpen(true) }}
            className="mt-1 gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Add {label} trigger
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-stagger">
      <Tabs defaultValue="cron">
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="cron" className="gap-1.5">
              <Clock className="h-3.5 w-3.5" /> Cron
              {cronTriggers.length > 0 && (
                <Badge variant="secondary" className="text-xs ml-1">{cronTriggers.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="webhook" className="gap-1.5">
              <Webhook className="h-3.5 w-3.5" /> {t('triggers.webhook')}
              {webhookTriggers.length > 0 && (
                <Badge variant="secondary" className="text-xs ml-1">{webhookTriggers.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {canManage && (
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t('triggers.new_trigger')}
            </Button>
          )}
        </div>

        <TabsContent value="cron">
          <Card>
            <CardContent className="p-0">
              {cronTriggers.length === 0 ? (
                <EmptyTriggers type="CRON" />
              ) : (
                <ul className="divide-y divide-surface-border">
                  {cronTriggers.map((tr) => <TriggerCard key={tr.id} trigger={tr} />)}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="webhook">
          <Card>
            <CardHeader className="pb-2">
              <p className="text-xs text-muted-foreground">
                Webhook triggers fire a new run when a POST request is received at the endpoint URL.{' '}
                {t('triggers.webhook_auth_hint_pre')} <code className="font-mono">Authorization</code> {t('triggers.webhook_auth_hint_post')}
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {webhookTriggers.length === 0 ? (
                <EmptyTriggers type="WEBHOOK" />
              ) : (
                <ul className="divide-y divide-surface-border">
                  {webhookTriggers.map((tr) => <TriggerCard key={tr.id} trigger={tr} />)}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-400" />
              New trigger
            </DialogTitle>
            <DialogDescription>
              Automatically start a run on a schedule or via an HTTP request.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={createType === 'CRON' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => setCreateType('CRON')}
                >
                  <Clock className="h-3.5 w-3.5" /> Cron
                </Button>
                <Button
                  type="button"
                  variant={createType === 'WEBHOOK' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 gap-1.5"
                  onClick={() => setCreateType('WEBHOOK')}
                >
                  <Webhook className="h-3.5 w-3.5" /> {t('triggers.webhook')}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trigger-name">Name</Label>
              <Input
                id="trigger-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Daily digest"
                maxLength={100}
                required
              />
            </div>
            {createType === 'CRON' && (
              <div className="space-y-1.5">
                <Label htmlFor="trigger-schedule">Cron schedule</Label>
                <Input
                  id="trigger-schedule"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="0 9 * * *"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">{humanizeCron(schedule)}</p>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving || !name.trim()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete trigger</DialogTitle>
            <DialogDescription>
              This trigger will stop firing immediately. This action cannot be undone.
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
