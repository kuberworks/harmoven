'use client'

// components/admin/OrchestratorConfigClient.tsx
// Editable form for the opt-in fields of orchestrator.yaml.
// Called from app/(app)/admin/instance/page.tsx (instance_admin only).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button }            from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrchestratorConfig {
  organization?:     { name?: string; preset?: string }
  execution_engine?: { provider?: string; max_concurrent_nodes?: number }
  privacy?:          { presidio?: { enabled?: boolean } }
  litellm?:          { enabled?: boolean }
  proactivity?:      { full_auto_enabled?: boolean; max_auto_runs_per_day?: number; max_cost_usd_per_day?: number }
  security?:         { rate_limit_provider?: string; allow_public_signup?: boolean }
  updates?:          { auto_install?: string; update_channel?: string; auto_check?: boolean; auto_download?: boolean }
  marketplace?:      { default_update_policy?: string; auto_check_updates?: boolean }
  web_search?:       { default_provider?: string }
}

interface Warning { field: string; message: string }

interface Props { initial: OrchestratorConfig }

// ─── Sub-components ───────────────────────────────────────────────────────────

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50
        ${checked ? 'bg-amber-500' : 'bg-surface-border'}`}
    >
      <span className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  )
}

function NumberInput({ value, onChange, min, max, step }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => {
        const n = parseFloat(e.target.value)
        if (!isNaN(n)) onChange(n)
      }}
      className="w-24 rounded-md border border-surface-border bg-surface-muted px-2 py-1 text-right text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
    />
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OrchestratorConfigClient({ initial }: Props) {
  const router = useRouter()

  const [cfg,    setCfg]    = useState<OrchestratorConfig>(initial)
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const [warnings, setWarnings] = useState<Warning[]>([])

  function patch<T>(path: string[], value: T) {
    setSaved(false)
    setCfg((prev) => deepSet(prev, path, value))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    setWarnings([])
    try {
      const res = await fetch('/api/admin/instance/orchestrator', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(cfg),
      })
      const data = await res.json() as { ok?: boolean; warnings?: Warning[]; error?: string; details?: unknown }
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setWarnings(data.warnings ?? [])
      setSaved(true)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const litellmEnabled   = cfg.litellm?.enabled          ?? false
  const presidioEnabled  = cfg.privacy?.presidio?.enabled ?? false
  const fullAuto         = cfg.proactivity?.full_auto_enabled ?? false
  const rateLimitProv    = cfg.security?.rate_limit_provider  ?? 'memory'
  const allowPublicSignup = cfg.security?.allow_public_signup ?? false
  const execProvider     = cfg.execution_engine?.provider    ?? 'custom'
  const autoInstall      = cfg.updates?.auto_install         ?? 'notify'
  const updateChannel    = cfg.updates?.update_channel       ?? 'stable'
  const marketplacePolicy = cfg.marketplace?.default_update_policy ?? 'notify'
  const maxRuns          = cfg.proactivity?.max_auto_runs_per_day ?? 20
  const maxCost          = cfg.proactivity?.max_cost_usd_per_day  ?? 10
  const webSearchProvider = cfg.web_search?.default_provider ?? 'brave'

  return (
    <div className="space-y-6">
      {/* ── Organisation ───────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-4 pb-2 divide-y divide-surface-border">
          <Row label="Organisation name">
            <input
              type="text"
              value={cfg.organization?.name ?? ''}
              onChange={(e) => patch(['organization', 'name'], e.target.value)}
              className="w-48 rounded-md border border-surface-border bg-surface-muted px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </Row>
          <Row label="Instance preset" description="Determines default concurrency limits and feature visibility.">
            <Select
              value={cfg.organization?.preset ?? 'small_business'}
              onValueChange={(v) => patch(['organization', 'preset'], v)}
            >
              <SelectTrigger className="w-44 h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="small_business">Small business</SelectItem>
                <SelectItem value="enterprise">Enterprise</SelectItem>
                <SelectItem value="developer">Developer</SelectItem>
              </SelectContent>
            </Select>
          </Row>
        </CardContent>
      </Card>

      {/* ── Execution engine ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Execution engine</h3>
        <Card>
          <CardContent className="pt-4 pb-2 divide-y divide-surface-border">
            <Row label="Provider" description="custom = built-in executor. temporal / restate require matching env vars.">
              <Select value={execProvider} onValueChange={(v) => patch(['execution_engine', 'provider'], v)}>
                <SelectTrigger className="w-32 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">Custom (default)</SelectItem>
                  <SelectItem value="temporal">Temporal</SelectItem>
                  <SelectItem value="restate">Restate</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Max concurrent nodes" description="Per-run concurrency limit.">
              <NumberInput
                value={cfg.execution_engine?.max_concurrent_nodes ?? 4}
                onChange={(v) => patch(['execution_engine', 'max_concurrent_nodes'], v)}
                min={1} max={64}
              />
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Optional services ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Optional services</h3>
        <Card>
          <CardContent className="pt-4 pb-2 divide-y divide-surface-border">
            <Row label="LiteLLM gateway" description="Route LLM calls through a LiteLLM sidecar. Requires LITELLM_GATEWAY_URL.">
              <Toggle checked={litellmEnabled} onChange={(v) => patch(['litellm', 'enabled'], v)} />
            </Row>
            <Row label="Presidio PII detection" description="Strip personally-identifiable information before sending to LLMs. Requires PRESIDIO_ENDPOINT.">
              <Toggle checked={presidioEnabled} onChange={(v) => patch(['privacy', 'presidio', 'enabled'], v)} />
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Rate limiting ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Registration &amp; access</h3>
        <Card>
          <CardContent className="pt-4 pb-2">
            <Row label="Public sign-up" description="Allow anyone with the URL to create an account. Disable for private / invite-only instances (default). Enable for SaaS / open registration.">
              <Toggle checked={allowPublicSignup} onChange={(v) => patch(['security', 'allow_public_signup'], v)} />
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Rate limiting ──────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Rate limiting</h3>
        <Card>
          <CardContent className="pt-4 pb-2">
            <Row label="Provider" description="memory = in-process (default, Electron-safe). upstash = Redis-backed (production, requires UPSTASH_REDIS_REST_URL).">
              <Select value={rateLimitProv} onValueChange={(v) => patch(['security', 'rate_limit_provider'], v)}>
                <SelectTrigger className="w-32 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="memory">Memory</SelectItem>
                  <SelectItem value="upstash">Upstash</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Proactivity ────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Proactivity</h3>
        <Card>
          <CardContent className="pt-4 pb-2 divide-y divide-surface-border">
            <Row label="Full-auto mode" description="Allow the system to start pipelines without human confirmation. Use with caution.">
              <Toggle checked={fullAuto} onChange={(v) => patch(['proactivity', 'full_auto_enabled'], v)} />
            </Row>
            <Row label="Max auto-runs per day">
              <NumberInput
                value={maxRuns}
                onChange={(v) => patch(['proactivity', 'max_auto_runs_per_day'], v)}
                min={1} max={1000}
              />
            </Row>
            <Row label="Max cost per day (USD)">
              <NumberInput
                value={maxCost}
                onChange={(v) => patch(['proactivity', 'max_cost_usd_per_day'], v)}
                min={0.01} max={10000} step={0.5}
              />
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Updates ────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Updates</h3>
        <Card>
          <CardContent className="pt-4 pb-2 divide-y divide-surface-border">
            <Row label="Auto-install policy">
              <Select value={autoInstall} onValueChange={(v) => patch(['updates', 'auto_install'], v)}>
                <SelectTrigger className="w-36 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="notify">Notify (default)</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Update channel">
              <Select value={updateChannel} onValueChange={(v) => patch(['updates', 'update_channel'], v)}>
                <SelectTrigger className="w-32 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stable">Stable</SelectItem>
                  <SelectItem value="edge">Edge</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Auto-check for updates">
              <Toggle
                checked={cfg.updates?.auto_check ?? true}
                onChange={(v) => patch(['updates', 'auto_check'], v)}
              />
            </Row>
            <Row label="Auto-download in background">
              <Toggle
                checked={cfg.updates?.auto_download ?? true}
                onChange={(v) => patch(['updates', 'auto_download'], v)}
              />
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Marketplace ────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Marketplace</h3>
        <Card>
          <CardContent className="pt-4 pb-2 divide-y divide-surface-border">
            <Row label="Default update policy">
              <Select value={marketplacePolicy} onValueChange={(v) => patch(['marketplace', 'default_update_policy'], v)}>
                <SelectTrigger className="w-36 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="notify">Notify (default)</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Auto-check pack updates">
              <Toggle
                checked={cfg.marketplace?.auto_check_updates ?? true}
                onChange={(v) => patch(['marketplace', 'auto_check_updates'], v)}
              />
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Web search ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Web search</h3>
        <Card>
          <CardContent className="pt-4 pb-2 divide-y divide-surface-border">
            <Row
              label="Default provider"
              description="Provider used when a run has enable_web_search: true. DuckDuckGo requires no API key. Brave and Tavily need their respective key in the environment."
            >
              <Select value={webSearchProvider} onValueChange={(v) => patch(['web_search', 'default_provider'], v)}>
                <SelectTrigger className="w-36 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="duckduckgo">DuckDuckGo (free)</SelectItem>
                  <SelectItem value="brave">Brave Search</SelectItem>
                  <SelectItem value="tavily">Tavily</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="API key status" description="Set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY in the server environment to activate the corresponding provider.">
              <div className="flex flex-col gap-1 text-xs text-muted-foreground font-mono">
                <span>BRAVE_SEARCH_API_KEY</span>
                <span>TAVILY_API_KEY</span>
              </div>
            </Row>
          </CardContent>
        </Card>
      </section>

      {/* ── Warnings ───────────────────────────────────────────────────────── */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w) => (
            <div key={w.field} className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span><span className="font-mono">{w.field}</span> — {w.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* ── Actions ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="bg-amber-500 hover:bg-amber-400 text-black font-medium h-8 px-4 text-sm"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save configuration'}
        </Button>
        {saved && !saving && (
          <span className="flex items-center gap-1.5 text-xs text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved to orchestrator.yaml
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deepSet<T>(obj: T, path: string[], value: unknown): T {
  if (path.length === 0) return value as T
  const [head, ...rest] = path
  if (!head) return value as T
  const record = obj as Record<string, unknown>
  return {
    ...record,
    [head]: rest.length === 0
      ? value
      : deepSet(record[head] ?? {}, rest, value),
  } as T
}
