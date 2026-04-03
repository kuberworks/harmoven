'use client'

// Import a pack from a GitHub raw URL with a mandatory human-review step.
// Flow:
//   1. Admin pastes GitHub URL → POST /api/admin/integrations/from-url → preview scaffold
//   1.5 If Smart Import is enabled → auto-call POST /api/admin/marketplace/analyze-command
//       (step: 'relevance_gate') and show result banners before step 2
//   2. Admin reviews all fields (inferred ones marked ⚠) and edits if needed
//   3. Admin clicks "Approuver" → POST /api/admin/integrations/from-url/approve
//   4. Pack created with enabled:false — admin must activate separately in Admin → Integrations

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, AlertTriangle, CheckCircle2, Info, Sparkles, X, BookOpen, Wrench, FileText, Bot, Puzzle, Slash } from 'lucide-react'
import type { GitHubImportPreview } from '@/lib/marketplace/from-github-url'
import { useT } from '@/lib/i18n/client'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PreviewResponse {
  preview_id: string
  preview:    GitHubImportPreview
  expires_at: string
  code?:      string
  error?:     string
}

interface ConfirmedFields {
  pack_id:        string
  name:           string
  version:        string
  commit_sha?:    string
  author:         string
  description:    string
  system_prompt:  string
  tags:           string[]
  capability_type: 'domain_pack' | 'mcp_skill' | 'prompt_only' | 'harmoven_agent' | 'js_ts_plugin' | 'slash_command'
  mcp_command?:   string
}

type CapabilityType = ConfirmedFields['capability_type']

const CAPABILITY_TYPES: CapabilityType[] = [
  'domain_pack',
  'mcp_skill',
  'prompt_only',
  'harmoven_agent',
  'js_ts_plugin',
  'slash_command',
]

const CAP_ICON: Record<CapabilityType, React.ElementType> = {
  domain_pack:    BookOpen,
  mcp_skill:      Wrench,
  prompt_only:    FileText,
  harmoven_agent: Bot,
  js_ts_plugin:   Puzzle,
  slash_command:  Slash,
}

const CAP_COLOR: Record<CapabilityType, string> = {
  domain_pack:    'text-purple-400',
  mcp_skill:      'text-blue-400',
  prompt_only:    'text-slate-300',
  harmoven_agent: 'text-emerald-400',
  js_ts_plugin:   'text-amber-400',
  slash_command:  'text-rose-400',
}

// Relevance gate API response
interface RelevanceGateResponse {
  outcome:            'RELEVANT' | 'UNCERTAIN' | 'NOT_RELEVANT'
  confidence:         number
  reasoning:          string
  risks:              string[]
  capability_summary: string
  budget:             {
    monthly_cost_usd:    number
    monthly_budget_usd:  number | null
    budget_percent_used: number | null
  }
}

interface AnalyzeErrorResponse {
  error:   string   // opaque code, e.g. PREVIEW_NOT_OWNED
  message: string   // human-readable detail
  budget?: {
    monthly_cost_usd:    number
    monthly_budget_usd:  number | null
    budget_percent_used: number | null
  }
}

interface ImportFromUrlClientProps {
  smartImportEnabled: boolean
}

// ─── URL normalizer ───────────────────────────────────────────────────────────
// Client-side hint only — actual normalisation (incl. directory scan) is done server-side.
// We only pre-convert /blob/ paths here since those are deterministic and need no API call.
//   github.com/{owner}/{repo}/blob/{branch}/{path}  → raw.githubusercontent.com (single file)
//   github.com/{owner}/{repo}/tree/{branch}/{path}  → passed through; server picks best pack file
// Returns null if no client-side conversion is needed.

type UrlHint =
  | { kind: 'single_file'; normalized: string; hint: string }
  | { kind: 'directory';   url: string }

function detectGitHubUrl(input: string): UrlHint | null {
  let parsed: URL
  try { parsed = new URL(input) } catch { return null }

  if (parsed.hostname !== 'github.com') return null

  const parts = parsed.pathname.replace(/^\//, '').split('/')
  if (parts.length < 2) return null

  const [owner, repo, type, branch, ...rest] = parts

  // github.com/{owner}/{repo}/blob/{branch}/{...path} → deterministic raw URL
  if (type === 'blob' && branch && rest.length > 0) {
    const normalized = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join('/')}`
    return { kind: 'single_file', normalized, hint: rest.join('/') }
  }

  // github.com/{owner}/{repo}/tree/… → server will scan directory for best pack file
  if (type === 'tree' && branch) {
    return { kind: 'directory', url: input }
  }

  return null
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function InferredBadge() {
  const t = useT()
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 font-mono">
      <AlertTriangle className="h-2.5 w-2.5" />
      {t('marketplace.add_from_git.inferred')}
    </span>
  )
}

function FieldRow({
  label,
  inferred,
  children,
}: {
  label:    string
  inferred: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
        {inferred && <InferredBadge />}
      </div>
      {children}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ImportFromUrlClient({ smartImportEnabled }: ImportFromUrlClientProps) {
  const router = useRouter()
  const t = useT()

  // Step 1 state
  const [url,      setUrl]      = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [urlHint,  setUrlHint]  = useState<UrlHint | null>(null)

  // Step 2 state
  const [previewId,  setPreviewId]  = useState<string | null>(null)
  const [preview,    setPreview]    = useState<GitHubImportPreview | null>(null)
  const [confirmed,  setConfirmed]  = useState<ConfirmedFields | null>(null)

  // Smart Import / relevance gate state
  const [analyzingGate,    setAnalyzingGate]    = useState(false)
  const [gateResult,       setGateResult]       = useState<RelevanceGateResponse | null>(null)
  const [gateError,        setGateError]        = useState<{ message: string; code: string } | null>(null)
  const [budgetHardBlock,  setBudgetHardBlock]  = useState(false)
  const [budgetSoftAlert,  setBudgetSoftAlert]  = useState(false)
  const [gateConfirmed,    setGateConfirmed]    = useState(false)
  const [skipSmartImport,  setSkipSmartImport]  = useState(false)

  // U12 smart import hint (dismissed via localStorage)
  const [u12Dismissed, setU12Dismissed] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('smart_import_hint_dismissed') === '1'
  })

  function dismissU12() {
    localStorage.setItem('smart_import_hint_dismissed', '1')
    setU12Dismissed(true)
  }

  // Step 3 state
  const [approving,               setApproving]               = useState(false)
  const [approveErr,              setApproveErr]              = useState<string | null>(null)
  const [success,                 setSuccess]                 = useState<string | null>(null)
  const [scanWarningsConfirmed,   setScanWarningsConfirmed]   = useState(false)

  // ── Step 1: fetch preview ─────────────────────────────────────────────────

  async function handleFetch(e: React.FormEvent) {
    e.preventDefault()
    setFetchErr(null)
    setPreview(null)
    setPreviewId(null)
    setConfirmed(null)
    setSuccess(null)
    setGateResult(null)
    setGateError(null)
    setBudgetHardBlock(false)
    setBudgetSoftAlert(false)
    setGateConfirmed(false)
    setSkipSmartImport(false)
    setUrlHint(null)

    const raw = url.trim()
    if (!raw) { setFetchErr(t('marketplace.add_from_git.url_required')); return }

    // Auto-normalize blob URLs client-side; directory (tree) URLs are resolved server-side
    const detected = detectGitHubUrl(raw)
    const resolvedUrl = (detected?.kind === 'single_file') ? detected.normalized : raw
    if (detected?.kind === 'single_file') setUrl(detected.normalized)

    setFetching(true)
    try {
      const res = await fetch('/api/admin/integrations/from-url', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: resolvedUrl }),
      })
      const data = await res.json() as PreviewResponse & { error?: string; code?: string }
      if (!res.ok) {
        const code = (data as { code?: string }).code
        const codeKey = code ? `marketplace.add_from_git.err_${code.toLowerCase()}` : null
        const translated = codeKey ? t(codeKey) : null
        // Use translated key if it resolved (not equal to the key itself), else fall back to server message
        setFetchErr((translated && translated !== codeKey ? translated : null) ?? (data as { error?: string }).error ?? t('marketplace.add_from_git.http_error', { status: String(res.status) }))
        return
      }
      setPreviewId(data.preview_id)
      setPreview(data.preview)
      // Pre-fill confirmed fields from scaffold
      setConfirmed({
        pack_id:        data.preview.pack_id.value,
        name:           data.preview.name.value,
        version:        data.preview.version.value,
        commit_sha:     data.preview.commit_sha,
        author:         data.preview.author.value,
        description:    data.preview.description.value,
        system_prompt:  data.preview.system_prompt.value,
        tags:           data.preview.tags.value,
        capability_type: data.preview.capability_type.value,
        mcp_command:    data.preview.mcp_command?.value,
      })

      // Step 1.5 — auto-trigger relevance gate if Smart Import enabled
      if (smartImportEnabled) {
        setAnalyzingGate(true)
        try {
          const gateRes = await fetch('/api/admin/marketplace/analyze-command', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ preview_id: data.preview_id, step: 'relevance_gate' }),
          })
          const gateData = await gateRes.json() as RelevanceGateResponse | AnalyzeErrorResponse
          if (!gateRes.ok) {
            const err = gateData as AnalyzeErrorResponse
            if (err.error === 'BUDGET_EXCEEDED') {
              setBudgetHardBlock(true)
            } else {
              setGateError({ code: err.error, message: err.message })
            }
            const b = err.budget
            if (b?.budget_percent_used !== null && (b?.budget_percent_used ?? 0) >= 80) {
              setBudgetSoftAlert(true)
            }
          } else {
            const result = gateData as RelevanceGateResponse
            setGateResult(result)
            const pct = result.budget?.budget_percent_used ?? 0
            if (pct >= 80 && pct < 100) setBudgetSoftAlert(true)
          }
        } finally {
          setAnalyzingGate(false)
        }
      }
    } finally {
      setFetching(false)
    }
  }

  // ── Step 3: approve ───────────────────────────────────────────────────────

  async function handleApprove(e: React.FormEvent) {
    e.preventDefault()
    if (!previewId || !confirmed) return
    setApproveErr(null)

    setApproving(true)
    try {
      const res = await fetch('/api/admin/integrations/from-url/approve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          preview_id: previewId,
          confirmed: {
            ...confirmed,
            scan_warnings_confirmed: scanWarningsConfirmed || undefined,
          },
        }),
      })
      const data = await res.json() as { message?: string; error?: string; code?: string }
      if (!res.ok) {
        if (data.code === 'CONTENT_CHANGED') {
          // Content changed — reset to step 1 forcing re-import
          setPreview(null)
          setPreviewId(null)
          setConfirmed(null)
        }
        setApproveErr(data.error ?? t('marketplace.add_from_git.http_error', { status: String(res.status) }))
        return
      }
      setSuccess(data.message ?? 'Pack enregistré.')
      setUrl('')
      setPreview(null)
      setPreviewId(null)
      setConfirmed(null)
      router.refresh()
    } finally {
      setApproving(false)
    }
  }

  // Whether the review form is ready to display (gate resolved or bypassed)
  const gateResolved =
    !smartImportEnabled ||
    skipSmartImport ||
    gateResult?.outcome === 'RELEVANT' ||
    (gateResult?.outcome === 'UNCERTAIN' && gateConfirmed) ||
    (gateResult?.outcome === 'NOT_RELEVANT' && gateConfirmed) ||
    (gateError !== null && skipSmartImport)

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* U12 — Smart Import disabled hint (dismissable) */}
      {!smartImportEnabled && !u12Dismissed && (
        <div className="flex items-start gap-2.5 rounded-md bg-blue-500/8 border border-blue-500/20 px-3 py-2.5 text-xs text-blue-300">
          <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-400" />
          <div className="flex-1 space-y-0.5">
            <p className="font-medium text-blue-200">{t('marketplace.add_from_git.smart_import_disabled_title')}</p>
            <p className="text-blue-300/70">
              {t('marketplace.add_from_git.smart_import_disabled_body')}
            </p>
          </div>
          <button
            type="button"
            className="text-blue-300/50 hover:text-blue-300 transition-colors mt-0.5"
            aria-label={t('marketplace.add_from_git.close')}
            onClick={dismissU12}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Step 1: URL input ─────────────────────────────────────────────── */}
      <form onSubmit={handleFetch} className="flex gap-2">
        <Input
          id="github-url"
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            const n = detectGitHubUrl(e.target.value.trim())
            setUrlHint(n)
          }}
          placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
          className="flex-1 font-mono text-xs"
          disabled={fetching || !!preview}
        />
        <Button type="submit" disabled={fetching || !!preview} size="sm" variant="outline">
          {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('marketplace.add_from_git.analyse')}
        </Button>
        {preview && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setPreview(null); setPreviewId(null); setConfirmed(null)
              setApproveErr(null); setGateResult(null); setGateError(null)
              setBudgetHardBlock(false); setBudgetSoftAlert(false)
              setGateConfirmed(false); setSkipSmartImport(false)
            }}
          >
            {t('marketplace.add_from_git.reset')}
          </Button>
        )}
      </form>

      {/* URL auto-conversion hint */}
      {urlHint && !preview && (
        <div className="flex items-center gap-2 text-xs text-blue-400">
          <Info className="h-3 w-3 shrink-0" />
          {urlHint.kind === 'single_file' ? (
            <>{t('marketplace.add_from_git.url_hint')}{' '}
              <code className="font-mono text-[10px] text-blue-300 break-all">{urlHint.normalized}</code>
            </>
          ) : (
            t('marketplace.add_from_git.url_hint_directory')
          )}
        </div>
      )}

      {fetchErr && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {fetchErr}
        </div>
      )}

      {/* ── Step 1.5: Relevance gate banners ─────────────────────────────── */}
      {preview && smartImportEnabled && (
        <div className="space-y-2">

          {/* Analyzing spinner */}
          {analyzingGate && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              {t('marketplace.add_from_git.analysing_gate')}
            </div>
          )}

          {/* Budget soft alert (80–99%) */}
          {budgetSoftAlert && !budgetHardBlock && (
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {t('marketplace.add_from_git.budget_soft_alert')}
            </div>
          )}

          {/* Budget hard block (100%) */}
          {budgetHardBlock && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/25 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {t('marketplace.add_from_git.budget_hard_block')}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => { setBudgetHardBlock(false); setSkipSmartImport(true) }}
              >
                {t('marketplace.add_from_git.budget_bypass')}
              </Button>
            </div>
          )}

          {/* Gate errors */}
          {gateError && !skipSmartImport && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {t('marketplace.add_from_git.gate_unavailable', { code: gateError.code, message: gateError.message })}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => setSkipSmartImport(true)}
              >
                {t('marketplace.add_from_git.gate_skip')}
              </Button>
            </div>
          )}

          {/* RELEVANT outcome — silent, green confirmation */}
          {gateResult?.outcome === 'RELEVANT' && (
            <div className="flex items-start gap-2 rounded-md bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{t('marketplace.add_from_git.gate_relevant_title')}</p>
                <p className="text-green-400/70 mt-0.5">{gateResult.capability_summary}</p>
              </div>
            </div>
          )}

          {/* UNCERTAIN outcome — warning + confirmation checkbox */}
          {gateResult?.outcome === 'UNCERTAIN' && (
            <div className="rounded-md bg-amber-500/10 border border-amber-500/25 px-3 py-2.5 text-xs space-y-2">
              <div className="flex items-start gap-2 text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">{t('marketplace.add_from_git.gate_uncertain_title')}</p>
                  <p className="text-amber-300/70 mt-0.5">{gateResult.reasoning}</p>
                  {gateResult.risks.length > 0 && (
                    <ul className="mt-1 list-disc list-inside text-amber-300/60 space-y-0.5">
                      {gateResult.risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  )}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-amber-200">
                <input
                  type="checkbox"
                  checked={gateConfirmed}
                  onChange={(e) => setGateConfirmed(e.target.checked)}
                  className="rounded border-amber-500/50"
                />
                {t('marketplace.add_from_git.gate_confirm_uncertain')}
              </label>
            </div>
          )}

          {/* NOT_RELEVANT outcome — red banner + confirmation checkbox */}
          {gateResult?.outcome === 'NOT_RELEVANT' && (
            <div className="rounded-md bg-destructive/10 border border-destructive/25 px-3 py-2.5 text-xs space-y-2">
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">{t('marketplace.add_from_git.gate_not_relevant_title')}</p>
                  <p className="text-destructive/70 mt-0.5">{gateResult.reasoning}</p>
                  {gateResult.risks.length > 0 && (
                    <ul className="mt-1 list-disc list-inside text-destructive/60 space-y-0.5">
                      {gateResult.risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  )}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-destructive/80">
                <input
                  type="checkbox"
                  checked={gateConfirmed}
                  onChange={(e) => setGateConfirmed(e.target.checked)}
                  className="rounded border-destructive/50"
                />
                {t('marketplace.add_from_git.gate_confirm_not_relevant')}
              </label>
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Review form (shown only when gate resolved) ───────────────── */}
      {preview && confirmed && gateResolved && (
        <form
          onSubmit={handleApprove}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target instanceof HTMLTextAreaElement) {
              e.preventDefault()
              e.currentTarget.requestSubmit()
            }
          }}
          className="space-y-4"
        >

          {/* ── Component type selector — MOST IMPORTANT, always first ─────── */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">
                {t('marketplace.add_from_git.component_type_label')}
              </span>
              {preview.capability_type.inferred && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 font-mono">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {t('marketplace.add_from_git.inferred')}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CAPABILITY_TYPES.map((ct) => {
                const Icon    = CAP_ICON[ct]
                const color   = CAP_COLOR[ct]
                const active  = confirmed.capability_type === ct
                return (
                  <button
                    key={ct}
                    type="button"
                    onClick={() => setConfirmed({ ...confirmed, capability_type: ct })}
                    className={[
                      'flex flex-col gap-1.5 rounded-md border px-3 py-2.5 text-left transition-colors',
                      active
                        ? 'border-primary bg-primary/10 ring-1 ring-primary/40'
                        : 'border-border bg-surface-overlay hover:border-primary/40 hover:bg-primary/5',
                    ].join(' ')}
                  >
                    <Icon className={`h-4 w-4 ${color}`} />
                    <span className="text-xs font-medium text-foreground leading-tight">
                      {t(`marketplace.capability_type.${ct}`)}
                    </span>
                    <span className="text-[10px] text-muted-foreground leading-snug">
                      {t(`marketplace.capability_type_desc.${ct}`)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Warning banner — always visible */}
          <div className="flex items-start gap-2 rounded-md bg-amber-500/8 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-200">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
            <div className="space-y-0.5">
              <p className="font-medium">{t('marketplace.add_from_git.review_warning_title')}</p>
              <p className="text-amber-300/80">
                {t('marketplace.add_from_git.review_warning_body')}
                {preview.has_inferred_fields && t('marketplace.add_from_git.review_warning_inferred')}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldRow label="Pack ID" inferred={preview.pack_id.inferred}>
              <Input
                value={confirmed.pack_id}
                onChange={(e) => setConfirmed({ ...confirmed, pack_id: e.target.value })}
                className="font-mono text-xs"
                pattern="^[a-z0-9_]{1,64}$"
                required
              />
            </FieldRow>

            <FieldRow label="Nom" inferred={preview.name.inferred}>
              <Input
                value={confirmed.name}
                onChange={(e) => setConfirmed({ ...confirmed, name: e.target.value })}
                className="text-xs"
                required
              />
            </FieldRow>

            <FieldRow label={t('marketplace.add_from_git.field_version')} inferred={preview.version.inferred}>
              <div className="flex gap-2">
                <Input
                  value={confirmed.version}
                  onChange={(e) => setConfirmed({ ...confirmed, version: e.target.value })}
                  className="font-mono text-xs flex-1"
                  placeholder="main, v1.2.3, ..."
                  required
                />
                {confirmed.commit_sha && (
                  <Input
                    value={confirmed.commit_sha}
                    readOnly
                    className="font-mono text-xs w-28 text-muted-foreground"
                    title="Commit SHA"
                  />
                )}
              </div>
            </FieldRow>

            <FieldRow label="Auteur" inferred={preview.author.inferred}>
              <Input
                value={confirmed.author}
                onChange={(e) => setConfirmed({ ...confirmed, author: e.target.value })}
                className="text-xs"
              />
            </FieldRow>
          </div>

          <FieldRow label="Description" inferred={preview.description.inferred}>
            <textarea
              value={confirmed.description}
              onChange={(e) => setConfirmed({ ...confirmed, description: e.target.value })}
              rows={2}
              className="w-full text-xs rounded-input border border-input bg-background px-3 py-2 ring-2 ring-ring focus-visible:outline-none focus-visible:ring-ring transition-colors resize-none"
            />
          </FieldRow>

          <FieldRow label="System Prompt" inferred={preview.system_prompt.inferred}>
            <textarea
              value={confirmed.system_prompt}
              onChange={(e) => setConfirmed({ ...confirmed, system_prompt: e.target.value })}
              rows={6}
              className="w-full font-mono text-xs rounded-input border border-input bg-background px-3 py-2 ring-2 ring-ring focus-visible:outline-none focus-visible:ring-ring transition-colors resize-y"
            />
          </FieldRow>

          {confirmed.capability_type === 'mcp_skill' && (
            <FieldRow label="Commande MCP" inferred={!confirmed.mcp_command}>
              <Input
                value={confirmed.mcp_command ?? ''}
                onChange={(e) => setConfirmed({ ...confirmed, mcp_command: e.target.value })}
                className="font-mono text-xs"
                placeholder="npx"
              />
            </FieldRow>
          )}

          {/* External URL scan warnings — must be confirmed before approve */}
          {preview.scan_warnings.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
                <p className="text-xs text-amber-300 font-medium">{t('marketplace.add_from_git.scan_warnings_title')}</p>
              </div>
              <ul className="space-y-1">
                {preview.scan_warnings.map((w) => (
                  <li key={w.url} className="text-[10px] font-mono text-amber-200/80 break-all">
                    {w.url}
                    <span className="ml-2 text-amber-400/60">sha256:{w.sha256.slice(0, 12)}… ({w.size} B)</span>
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={scanWarningsConfirmed}
                  onChange={(e) => setScanWarningsConfirmed(e.target.checked)}
                  className="accent-amber-400"
                />
                <span className="text-xs text-amber-300">{t('marketplace.add_from_git.scan_warnings_confirm')}</span>
              </label>
            </div>
          )}

          {/* SHA-256 traceability — read-only, with disclaimer (SEC-03) */}
          <div className="rounded-md bg-surface-overlay border border-surface-border px-3 py-2 text-[10px] space-y-0.5">
            <p className="font-mono text-muted-foreground break-all">
              SHA-256 : {preview.content_sha256}
            </p>
            <p className="text-muted-foreground/60">
              {t('marketplace.add_from_git.sha_disclaimer')}
            </p>
          </div>

          {approveErr && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {approveErr}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <p className="text-[10px] text-muted-foreground flex-1">
              {t('marketplace.add_from_git.approved_disabled')}
            </p>
            <Button
              type="submit"
              disabled={approving || (preview.scan_warnings.length > 0 && !scanWarningsConfirmed)}
              size="sm"
            >
              {approving
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> {t('marketplace.add_from_git.approving')}</>
                : t('marketplace.add_from_git.approve')}
            </Button>
          </div>
        </form>
      )}

      {success && (
        <div className="flex items-start gap-2 rounded-md bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs text-green-400">
          <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}
    </div>
  )
}
