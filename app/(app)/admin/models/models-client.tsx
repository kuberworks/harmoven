'use client'

// app/(app)/admin/models/models-client.tsx
// Interactive CRUD UI for LLM profiles (instance_admin only).
// Talks to:  GET/POST /api/admin/models
//            PATCH/DELETE /api/admin/models/:id

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog'
import { Button }  from '@/components/ui/button'
import { Input }   from '@/components/ui/input'
import { Label }   from '@/components/ui/label'
import { Badge }   from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Cpu, Plus, Pencil, Trash2, Loader2, KeyRound } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LlmProfileRow {
  id:                        string
  provider:                  string
  model_string:              string
  tier:                      string
  jurisdiction:              string
  trust_tier:                number
  context_window:            number
  cost_per_1m_input_tokens:  number
  cost_per_1m_output_tokens: number
  task_type_affinity:        string[]
  enabled:                   boolean
  config:                    Record<string, unknown>
}

interface FormState {
  id:                        string
  provider:                  string
  model_string:              string
  tier:                      'fast' | 'balanced' | 'powerful'
  jurisdiction:              'us' | 'eu' | 'cn' | 'local'
  trust_tier:                '1' | '2' | '3'
  context_window:            string
  cost_in:                   string
  cost_out:                  string
  task_type_affinity:        string   // comma-separated
  enabled:                   boolean
  base_url:                  string   // config.base_url
  api_key_env:               string   // config.api_key_env
  api_key:                   string   // plaintext — encrypted on save, never shown back
}

const EMPTY_FORM: FormState = {
  id: '', provider: '', model_string: '', tier: 'balanced', jurisdiction: 'eu',
  trust_tier: '1', context_window: '128000', cost_in: '0', cost_out: '0',
  task_type_affinity: '', enabled: true, base_url: '', api_key_env: '', api_key: '',
}

function profileToForm(m: LlmProfileRow): FormState {
  const cfg = m.config ?? {}
  return {
    id:                 m.id,
    provider:           m.provider,
    model_string:       m.model_string,
    tier:               m.tier as FormState['tier'],
    jurisdiction:       m.jurisdiction as FormState['jurisdiction'],
    trust_tier:         String(m.trust_tier) as FormState['trust_tier'],
    context_window:     String(m.context_window),
    cost_in:            String(m.cost_per_1m_input_tokens),
    cost_out:           String(m.cost_per_1m_output_tokens),
    task_type_affinity: (m.task_type_affinity ?? []).join(', '),
    enabled:            m.enabled,
    base_url:           typeof cfg.base_url === 'string' ? cfg.base_url : '',
    api_key_env:        typeof cfg.api_key_env === 'string' ? cfg.api_key_env : '',
    api_key:            '',  // never pre-filled — write-only
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIER_VARIANT: Record<string, 'running' | 'pending' | 'paused'> = {
  fast: 'running', balanced: 'paused', powerful: 'pending',
}
const TRUST_LABEL: Record<number, string> = { 1: 'Public', 2: 'Private', 3: 'Local' }
const PROVIDERS = ['anthropic', 'openai', 'gemini', 'cometapi', 'ollama', 'mistral', 'custom']

// ─── Select helper ────────────────────────────────────────────────────────────

function Select({
  id, value, onChange, children, className,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={[
        'flex h-9 w-full rounded-input border border-border bg-surface-raised px-3 py-1 text-sm',
        'text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      ].filter(Boolean).join(' ')}
    >
      {children}
    </select>
  )
}

// ─── Field wrapper ────────────────────────────────────────────────────────────

function Field({ label, htmlFor, hint, children }: {
  label: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ─── Model form dialog ────────────────────────────────────────────────────────

function ModelDialog({
  open, onClose, initial, isEdit, hasStoredKey, onSaved,
}: {
  open: boolean
  onClose: () => void
  initial: FormState
  isEdit: boolean
  hasStoredKey: boolean
  onSaved: (updated: LlmProfileRow) => void
}) {
  const [form, setForm] = useState<FormState>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when dialog opens with a new initial value
  const resetTo = useCallback((f: FormState) => {
    setForm(f)
    setError(null)
  }, [])

  // Called externally via key prop change — not needed; handled by parent resetting open
  const set = (field: keyof FormState) => (
    (val: string | boolean) => setForm((prev) => ({ ...prev, [field]: val }))
  )

  async function submit() {
    setError(null)
    setSaving(true)
    try {
      const affinities = form.task_type_affinity
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const config: Record<string, string> = {}
      if (form.base_url.trim())    config.base_url    = form.base_url.trim()
      if (form.api_key_env.trim()) config.api_key_env = form.api_key_env.trim()

      const body: Record<string, unknown> = {
        id:                        isEdit ? undefined : form.id.trim(),
        provider:                  form.provider.trim(),
        model_string:              form.model_string.trim(),
        tier:                      form.tier,
        jurisdiction:              form.jurisdiction,
        trust_tier:                parseInt(form.trust_tier, 10),
        context_window:            parseInt(form.context_window, 10),
        cost_per_1m_input_tokens:  parseFloat(form.cost_in),
        cost_per_1m_output_tokens: parseFloat(form.cost_out),
        task_type_affinity:        affinities,
        enabled:                   form.enabled,
        config,
        // Pass api_key only when the user typed something (or '' to clear an existing key)
        ...(form.api_key !== undefined && { api_key: form.api_key }),
      }

      let res: Response
      if (isEdit) {
        const { id: _id, ...patchBody } = body
        res = await fetch(`/api/admin/models/${encodeURIComponent(form.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        })
      } else {
        res = await fetch('/api/admin/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }))
        setError(typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
        return
      }

      const data = await res.json()
      onSaved(data.model as LlmProfileRow)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit — ${form.id}` : 'Add LLM model'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the profile fields. The model ID cannot be changed.'
              : 'Create a new LLM profile. The ID must be unique.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4 py-2">
          {/* ID — read-only on edit */}
          {!isEdit && (
            <div className="col-span-2">
              <Field label="Model ID" htmlFor="m-id" hint="Unique identifier, e.g. claude-sonnet-4-6">
                <Input
                  id="m-id"
                  value={form.id}
                  onChange={(e) => set('id')(e.target.value)}
                  placeholder="my-model-id"
                />
              </Field>
            </div>
          )}

          {/* Provider */}
          <Field label="Provider" htmlFor="m-provider">
            <Input
              id="m-provider"
              list="provider-list"
              value={form.provider}
              onChange={(e) => set('provider')(e.target.value)}
              placeholder="anthropic"
              autoComplete="off"
            />
            <datalist id="provider-list">
              {PROVIDERS.map((p) => <option key={p} value={p} />)}
            </datalist>
          </Field>

          {/* Model string */}
          <Field label="Model string" htmlFor="m-model-string" hint="Exact identifier sent to the API">
            <Input
              id="m-model-string"
              value={form.model_string}
              onChange={(e) => set('model_string')(e.target.value)}
              placeholder="claude-sonnet-4-6"
            />
          </Field>

          {/* Tier */}
          <Field label="Tier" htmlFor="m-tier">
            <Select id="m-tier" value={form.tier} onChange={(v) => set('tier')(v)}>
              <option value="fast">fast</option>
              <option value="balanced">balanced</option>
              <option value="powerful">powerful</option>
            </Select>
          </Field>

          {/* Jurisdiction */}
          <Field label="Jurisdiction" htmlFor="m-juris">
            <Select id="m-juris" value={form.jurisdiction} onChange={(v) => set('jurisdiction')(v)}>
              <option value="eu">EU</option>
              <option value="us">US</option>
              <option value="local">Local</option>
              <option value="cn">CN</option>
            </Select>
          </Field>

          {/* Trust tier */}
          <Field label="Trust tier" htmlFor="m-trust">
            <Select id="m-trust" value={form.trust_tier} onChange={(v) => set('trust_tier')(v)}>
              <option value="1">1 — Public (audited SLA)</option>
              <option value="2">2 — Private (standard SLA)</option>
              <option value="3">3 — Local / unvetted</option>
            </Select>
          </Field>

          {/* Context window */}
          <Field label="Context window (tokens)" htmlFor="m-ctx">
            <Input
              id="m-ctx"
              type="number"
              min={1}
              step={1000}
              value={form.context_window}
              onChange={(e) => set('context_window')(e.target.value)}
            />
          </Field>

          {/* Costs */}
          <Field label="Cost — input (€/1M tokens)" htmlFor="m-cin">
            <Input
              id="m-cin"
              type="number"
              min={0}
              step={0.01}
              value={form.cost_in}
              onChange={(e) => set('cost_in')(e.target.value)}
            />
          </Field>

          <Field label="Cost — output (€/1M tokens)" htmlFor="m-cout">
            <Input
              id="m-cout"
              type="number"
              min={0}
              step={0.01}
              value={form.cost_out}
              onChange={(e) => set('cost_out')(e.target.value)}
            />
          </Field>

          {/* Task affinity */}
          <div className="col-span-2">
            <Field
              label="Task type affinity"
              htmlFor="m-affinity"
              hint="Comma-separated list, e.g. report_writing, legal_reasoning"
            >
              <Input
                id="m-affinity"
                value={form.task_type_affinity}
                onChange={(e) => set('task_type_affinity')(e.target.value)}
                placeholder="document_analysis, report_writing"
              />
            </Field>
          </div>

          {/* base_url */}
          <div className="col-span-2">
            <Field
              label="Base URL (optional)"
              htmlFor="m-baseurl"
              hint="Override for OpenAI-compatible providers (Ollama, CometAPI, custom). Leave blank for official APIs."
            >
              <Input
                id="m-baseurl"
                type="url"
                value={form.base_url}
                onChange={(e) => set('base_url')(e.target.value)}
                placeholder="https://api.my-provider.com/v1"
              />
            </Field>
          </div>

          {/* api_key_env */}
          <div className="col-span-2">
            <Field
              label="API key env variable (optional)"
              htmlFor="m-apienv"
              hint="Name of the environment variable that holds the API key, e.g. MY_PROVIDER_API_KEY"
            >
              <Input
                id="m-apienv"
                value={form.api_key_env}
                onChange={(e) => set('api_key_env')(e.target.value)}
                placeholder="OPENAI_API_KEY"
              />
            </Field>
          </div>

          {/* api_key — encrypted storage in DB */}
          <div className="col-span-2">
            <Field
              label={
                <span className="flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" />
                  API key — store encrypted
                  {isEdit && hasStoredKey && (
                    <span className="ml-1 rounded-full bg-[var(--accent-amber-3)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-amber-9)]">
                      ● stored
                    </span>
                  )}
                </span>
              }
              htmlFor="m-apikey"
              hint={
                isEdit && hasStoredKey
                  ? 'A key is stored. Enter a new value to replace it, or leave blank to keep it. Clear with the × button.'
                  : 'Stored encrypted with AES-256-GCM. Ignored if empty. Takes priority over the env variable above.'
              }
            >
              <div className="flex gap-1.5">
                <Input
                  id="m-apikey"
                  type="password"
                  autoComplete="new-password"
                  value={form.api_key}
                  onChange={(e) => set('api_key')(e.target.value)}
                  placeholder={isEdit && hasStoredKey ? '(keep existing)' : 'sk-…'}
                  className="flex-1"
                />
                {isEdit && hasStoredKey && (
                  <button
                    type="button"
                    title="Clear stored key"
                    className="shrink-0 rounded border border-destructive/40 px-2 text-xs text-destructive hover:bg-destructive/10"
                    onClick={() => set('api_key')('')}
                  >
                    ×
                  </button>
                )}
              </div>
            </Field>
          </div>

          {/* Enabled toggle */}
          <div className="col-span-2 flex items-center gap-2 pt-1">
            <input
              id="m-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled')(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-surface-raised accent-amber-500"
            />
            <Label htmlFor="m-enabled">Enabled</Label>
          </div>
        </div>

        {error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : isEdit ? 'Save changes' : 'Create model'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Delete confirmation dialog ───────────────────────────────────────────────

function DeleteDialog({
  model, onClose, onDeleted,
}: {
  model: LlmProfileRow | null
  onClose: () => void
  onDeleted: (id: string) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  async function confirm() {
    if (!model) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/admin/models/${encodeURIComponent(model.id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }))
        setError(typeof data.error === 'string' ? data.error : 'Delete failed')
        return
      }
      onDeleted(model.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={!!model} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete model?</DialogTitle>
          <DialogDescription>
            <span className="font-mono font-medium text-foreground">{model?.id}</span> will be
            permanently removed. Runs that used this model are not affected.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Per-row actions ──────────────────────────────────────────────────────────

function ModelRowActions({
  model, onEdit, onDelete, onToggle,
}: {
  model: LlmProfileRow
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}) {
  const [toggling, setToggling] = useState(false)

  async function toggle() {
    setToggling(true)
    try {
      await onToggle()
    } finally {
      setToggling(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Button size="sm" variant="ghost" onClick={onEdit} title="Edit model">
        <Pencil className="h-3.5 w-3.5" />
        <span className="sr-only">Edit</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={toggle}
        disabled={toggling}
        title={model.enabled ? 'Disable model' : 'Enable model'}
      >
        {toggling
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <span className="text-xs">{model.enabled ? 'Disable' : 'Enable'}</span>}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDelete} title="Delete model"
        className="text-destructive hover:text-destructive hover:bg-destructive/10">
        <Trash2 className="h-3.5 w-3.5" />
        <span className="sr-only">Delete</span>
      </Button>
    </div>
  )
}

// ─── Main client component ────────────────────────────────────────────────────

export interface ModelsAdminClientProps {
  initialModels: LlmProfileRow[]
}

export function ModelsAdminClient({ initialModels }: ModelsAdminClientProps) {
  const router = useRouter()

  const [models, setModels] = useState<LlmProfileRow[]>(initialModels)

  // Dialog state
  const [formOpen,     setFormOpen]     = useState(false)
  const [formInitial,  setFormInitial]  = useState<FormState>(EMPTY_FORM)
  const [isEditMode,   setIsEditMode]   = useState(false)
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<LlmProfileRow | null>(null)

  // ── Helpers ────────────────────────────────────────────────────────────────

  function openCreate() {
    setFormInitial(EMPTY_FORM)
    setIsEditMode(false)
    setHasStoredKey(false)
    setFormOpen(true)
  }

  function openEdit(m: LlmProfileRow) {
    setFormInitial(profileToForm(m))
    setIsEditMode(true)
    setHasStoredKey(typeof m.config?.api_key_enc === 'string')
    setFormOpen(true)
  }

  function handleSaved(updated: LlmProfileRow) {
    setModels((prev) => {
      const idx = prev.findIndex((m) => m.id === updated.id)
      if (idx === -1) return [updated, ...prev]
      const next = [...prev]
      next[idx] = updated
      return next
    })
  }

  function handleDeleted(id: string) {
    setModels((prev) => prev.filter((m) => m.id !== id))
  }

  async function handleToggle(model: LlmProfileRow) {
    const res = await fetch(`/api/admin/models/${encodeURIComponent(model.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !model.enabled }),
    })
    if (!res.ok) return
    const data = await res.json()
    handleSaved(data.model as LlmProfileRow)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const enabledCount = models.filter((m) => m.enabled).length

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">LLM Models</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {enabledCount} active / {models.length} total profiles
          </p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          Add model
        </Button>
      </div>

      {/* Model list */}
      {models.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Cpu className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No LLM profiles configured.</p>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Add your first model
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-surface-border">
            {models
              .slice()
              .sort((a, b) => {
                // enabled first, then by tier order, then by id
                if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
                const tierOrder = { fast: 0, balanced: 1, powerful: 2 }
                const ta = tierOrder[a.tier as keyof typeof tierOrder] ?? 9
                const tb = tierOrder[b.tier as keyof typeof tierOrder] ?? 9
                if (ta !== tb) return ta - tb
                return a.id.localeCompare(b.id)
              })
              .map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground font-mono">{m.model_string}</span>
                      <Badge variant={TIER_VARIANT[m.tier] ?? 'pending'}>{m.tier}</Badge>
                      {!m.enabled && <Badge variant="suspended">disabled</Badge>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                      <span>{m.provider}</span>
                      <span>·</span>
                      <span>{(m.context_window / 1000).toFixed(0)}k ctx</span>
                      <span>·</span>
                      <span>Trust: {TRUST_LABEL[m.trust_tier] ?? m.trust_tier}</span>
                      <span>·</span>
                      <span>{m.jurisdiction.toUpperCase()}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground font-mono">
                      <span>In: €{Number(m.cost_per_1m_input_tokens).toFixed(2)}/1M</span>
                      <span>Out: €{Number(m.cost_per_1m_output_tokens).toFixed(2)}/1M</span>
                      {typeof m.config?.base_url === 'string' && m.config.base_url && (
                        <>
                          <span>·</span>
                          <span className="truncate max-w-[200px]" title={m.config.base_url}>
                            {m.config.base_url}
                          </span>
                        </>
                      )}
                      {typeof m.config?.api_key_enc === 'string' && (
                        <>
                          <span>·</span>
                          <span className="flex items-center gap-0.5 text-[var(--accent-amber-9)]">
                            <KeyRound className="h-3 w-3" /> key stored
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <ModelRowActions
                    model={m}
                    onEdit={() => openEdit(m)}
                    onDelete={() => setDeleteTarget(m)}
                    onToggle={() => handleToggle(m)}
                  />
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      {/* Create / edit dialog */}
      <ModelDialog
        key={isEditMode ? `edit-${formInitial.id}` : 'create'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        initial={formInitial}
        isEdit={isEditMode}
        hasStoredKey={hasStoredKey}
        onSaved={handleSaved}
      />

      {/* Delete confirmation */}
      <DeleteDialog
        model={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={handleDeleted}
      />
    </>
  )
}
