'use client'

// Import a pack from a GitHub raw URL with a mandatory human-review step.
// Flow:
//   1. Admin pastes GitHub URL → POST /api/admin/skills/from-url → preview scaffold
//   2. Admin reviews all fields (inferred ones marked ⚠) and edits if needed
//   3. Admin clicks "Approuver" → POST /api/admin/skills/from-url/approve
//   4. Pack created with enabled:false — admin must activate separately in Admin → Skills

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, AlertTriangle, CheckCircle2, Info } from 'lucide-react'
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

export function ImportFromUrlClient() {
  const router = useRouter()

  // Step 1 state
  const [url,      setUrl]      = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)

  // Step 2 state
  const [previewId,  setPreviewId]  = useState<string | null>(null)
  const [preview,    setPreview]    = useState<GitHubImportPreview | null>(null)
  const [confirmed,  setConfirmed]  = useState<ConfirmedFields | null>(null)

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

    if (!url.trim()) { setFetchErr('URL requise.'); return }

    setFetching(true)
    try {
      const res = await fetch('/api/admin/skills/from-url', {
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
      const res = await fetch('/api/admin/skills/from-url/approve', {
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

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
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
            onClick={() => { setPreview(null); setPreviewId(null); setConfirmed(null); setApproveErr(null) }}
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

      {/* ── Step 2: Review form ───────────────────────────────────────────── */}
      {preview && confirmed && (
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
                Ce pack provient d'une source non officielle. Aucune signature GPG — aucune garantie d'intégrité cryptographique.
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
              Ce hash est calculé localement. Sans signature GPG, il ne garantit pas l'intégrité du contenu en transit.
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
              Le pack sera créé <strong>désactivé</strong>. Activez-le manuellement dans Admin → Skills.
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
