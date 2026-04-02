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
import { Loader2, AlertTriangle, CheckCircle2, Info, Sparkles, X } from 'lucide-react'
import type { GitHubImportPreview } from '@/lib/marketplace/from-github-url'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PreviewResponse {
  preview_id: string
  preview:    GitHubImportPreview
  expires_at: string
}

interface ConfirmedFields {
  pack_id:        string
  name:           string
  version:        string
  author:         string
  description:    string
  system_prompt:  string
  tags:           string[]
  capability_type: 'domain_pack' | 'mcp_skill' | 'prompt_only'
  mcp_command?:   string
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
  error: string
  code:  string
  budget?: {
    monthly_cost_usd:    number
    monthly_budget_usd:  number | null
    budget_percent_used: number | null
  }
}

interface ImportFromUrlClientProps {
  smartImportEnabled: boolean
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function InferredBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 font-mono">
      <AlertTriangle className="h-2.5 w-2.5" />
      Inféré
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

  // Step 1 state
  const [url,      setUrl]      = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)

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
  const [approving,  setApproving]  = useState(false)
  const [approveErr, setApproveErr] = useState<string | null>(null)
  const [success,    setSuccess]    = useState<string | null>(null)

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

    if (!url.trim()) { setFetchErr('URL requise.'); return }

    setFetching(true)
    try {
      const res = await fetch('/api/admin/integrations/from-url', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: url.trim() }),
      })
      const data = await res.json() as PreviewResponse & { error?: string }
      if (!res.ok) {
        setFetchErr((data as { error?: string }).error ?? `Erreur HTTP ${res.status}`)
        return
      }
      setPreviewId(data.preview_id)
      setPreview(data.preview)
      // Pre-fill confirmed fields from scaffold
      setConfirmed({
        pack_id:        data.preview.pack_id.value,
        name:           data.preview.name.value,
        version:        data.preview.version.value,
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
            if (err.code === 'BUDGET_EXCEEDED') {
              setBudgetHardBlock(true)
            } else {
              setGateError({ message: err.error, code: err.code })
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
        body:    JSON.stringify({ preview_id: previewId, confirmed }),
      })
      const data = await res.json() as { message?: string; error?: string; code?: string }
      if (!res.ok) {
        if (data.code === 'CONTENT_CHANGED') {
          // Content changed — reset to step 1 forcing re-import
          setPreview(null)
          setPreviewId(null)
          setConfirmed(null)
        }
        setApproveErr(data.error ?? `Erreur HTTP ${res.status}`)
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
            <p className="font-medium text-blue-200">Smart Import disponible mais désactivé</p>
            <p className="text-blue-300/70">
              Activez Smart Import dans Admin → Marketplace → Smart Import pour bénéficier de
              l&apos;analyse de pertinence et de la génération automatique de manifeste.
            </p>
          </div>
          <button
            type="button"
            className="text-blue-300/50 hover:text-blue-300 transition-colors mt-0.5"
            aria-label="Fermer"
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
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://raw.githubusercontent.com/owner/repo/main/pack.toml"
          className="flex-1 font-mono text-xs"
          disabled={fetching || !!preview}
        />
        <Button type="submit" disabled={fetching || !!preview} size="sm" variant="outline">
          {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Analyser'}
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
            Réinitialiser
          </Button>
        )}
      </form>

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
              Analyse de pertinence en cours…
            </div>
          )}

          {/* Budget soft alert (80–99%) */}
          {budgetSoftAlert && !budgetHardBlock && (
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Budget LLM mensuel utilisé à plus de 80 %. Envisagez d&apos;augmenter le budget dans Admin → Marketplace → Smart Import.
            </div>
          )}

          {/* Budget hard block (100%) */}
          {budgetHardBlock && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/25 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Budget LLM épuisé pour ce mois. L&apos;analyse Smart Import est suspendue.
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => { setBudgetHardBlock(false); setSkipSmartImport(true) }}
              >
                Importer sans analyse LLM
              </Button>
            </div>
          )}

          {/* Gate errors */}
          {gateError && !skipSmartImport && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/25 px-3 py-2 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Analyse Smart Import indisponible ({gateError.code}) : {gateError.message}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => setSkipSmartImport(true)}
              >
                Importer sans analyse LLM
              </Button>
            </div>
          )}

          {/* RELEVANT outcome — silent, green confirmation */}
          {gateResult?.outcome === 'RELEVANT' && (
            <div className="flex items-start gap-2 rounded-md bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Pack pertinent</p>
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
                  <p className="font-medium">Pertinence incertaine</p>
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
                Je confirme vouloir importer malgré l&apos;incertitude
              </label>
            </div>
          )}

          {/* NOT_RELEVANT outcome — red banner + confirmation checkbox */}
          {gateResult?.outcome === 'NOT_RELEVANT' && (
            <div className="rounded-md bg-destructive/10 border border-destructive/25 px-3 py-2.5 text-xs space-y-2">
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Pack non pertinent selon l&apos;analyse LLM</p>
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
                Je comprends et veux importer quand même
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

          {/* Warning banner — always visible */}
          <div className="flex items-start gap-2 rounded-md bg-amber-500/8 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-200">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
            <div className="space-y-0.5">
              <p className="font-medium">Validation humaine obligatoire</p>
              <p className="text-amber-300/80">
                Ce pack provient d&apos;une source non officielle. Aucune signature GPG — aucune garantie d&apos;intégrité cryptographique.
                {preview.has_inferred_fields && ' Les champs marqués ⚠ Inféré ont été déduits automatiquement — vérifiez-les.'}
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

            <FieldRow label="Version" inferred={preview.version.inferred}>
              <Input
                value={confirmed.version}
                onChange={(e) => setConfirmed({ ...confirmed, version: e.target.value })}
                className="font-mono text-xs"
                pattern="^\d{1,4}\.\d{1,4}\.\d{1,4}$"
                required
              />
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

          {/* SHA-256 traceability — read-only, with disclaimer (SEC-03) */}
          <div className="rounded-md bg-surface-overlay border border-surface-border px-3 py-2 text-[10px] space-y-0.5">
            <p className="font-mono text-muted-foreground break-all">
              SHA-256 : {preview.content_sha256}
            </p>
            <p className="text-muted-foreground/60">
              Ce hash est calculé localement. Sans signature GPG, il ne garantit pas l&apos;intégrité du contenu en transit.
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
              Le pack sera créé <strong>désactivé</strong>. Activez-le manuellement dans Admin → Integrations.
            </p>
            <Button type="submit" disabled={approving} size="sm">
              {approving
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Approbation…</>
                : 'Approuver le pack'}
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
