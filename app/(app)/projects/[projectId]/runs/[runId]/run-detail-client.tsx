'use client'

// app/(app)/projects/[projectId]/runs/[runId]/run-detail-client.tsx
// Live run view — SSE-powered, progressive disclosure levels.
// Receives initial state from Server Component, wires up useRunStream for updates.
// UX spec §3.5 — ExecutingView (Level 1–4), CompletedView, ProblemView.

import { useEffect, useRef, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRunStream, type RunState, type NodeState } from '@/hooks/useRunStream'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PauseControls } from '@/components/run/PauseControls'
import { ContextInjectionPanel } from '@/components/run/ContextInjectionPanel'
import { DagView } from '@/components/run/DagView'
import { PermissionGuard } from '@/components/shared/PermissionGuard'
import { useT } from '@/lib/i18n/client'
import { AlertTriangle, CheckCircle2, XCircle, Loader2, ExternalLink, Star, RotateCcw, FileText, Printer } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

/**
 * Extract readable text from a partial LLM JSON response.
 * The WRITER outputs JSON like { "output": { "content": "..." } } being built token by token.
 * This tries to pull the content string out; falls back to the raw buffer.
 */
function extractStreamingContent(partial: string): string {
  const match = partial.match(/"content"\s*:\s*"([\s\S]*)$/)
  if (match) {
    return match[1]!
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      // Strip trailing incomplete escape sequence at the cut point
      .replace(/\\$/, '')
  }
  return partial
}
import { RUN_STATUS_VARIANT } from '@/lib/utils/run-status'
import type { Permission } from '@/lib/auth/permissions'
import type { Dag } from '@/types/dag.types'
import type { RunStatus, NodeStatus } from '@/types/run.types'

// ─── Types ─────────────────────────────────────────────────────────────────

interface InitialRun {
  id: string
  status: string
  task_input: string | null
  cost_actual_usd: number
  tokens_actual: number
  paused_at: string | null
  started_at: string | null
  completed_at: string | null
  transparency_mode: boolean
  dag: Dag
  budget_usd: number | null
  openGate: { id: string; reason: string } | null
}

interface InitialNode {
  id: string
  node_id: string
  agent_type: string
  status: string
  llm_profile_id: string | null
  started_at: string | null
  completed_at: string | null
  error: string | null
  cost_usd: number
  tokens_in: number
  tokens_out: number
  partial_output: string | null
  handoff_out: unknown
}

interface AuditEntry {
  id: string
  action_type: string
  node_id: string | null
  payload: Record<string, unknown> | null
  timestamp: string
}

interface Props {
  projectId: string
  initialRun: InitialRun
  initialNodes: InitialNode[]
  permissions: Set<Permission>
  initialEvents: AuditEntry[]
  uiLevel: 'GUIDED' | 'STANDARD' | 'ADVANCED'
}

// ─── Post-run feedback panel ────────────────────────────────────────────────

function FeedbackPanel({ runId }: { runId: string }) {
  const t = useT()
  const [rating,       setRating]       = useState(0)
  const [hovered,      setHovered]      = useState(0)
  const [hoursSaved,   setHoursSaved]   = useState('')
  const [valueNote,    setValueNote]    = useState('')
  const [submitting,   setSubmitting]   = useState(false)
  const [submitted,    setSubmitted]    = useState(false)
  const [skipped,      setSkipped]      = useState(false)
  const [error,        setError]        = useState<string | null>(null)

  const submit = useCallback(async () => {
    if (!rating) return
    setSubmitting(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { user_rating: rating }
      const h = parseFloat(hoursSaved)
      if (!isNaN(h) && h >= 0) body.estimated_hours_saved = h
      if (valueNote.trim()) body.business_value_note = valueNote.trim()

      const res = await fetch(`/api/runs/${runId}/feedback`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSubmitted(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit feedback.')
    } finally {
      setSubmitting(false)
    }
  }, [runId, rating, hoursSaved, valueNote])

  if (skipped || submitted) return (
    <Card>
      <CardContent className="py-4 text-center text-sm text-muted-foreground">
        {submitted ? '✓ ' + t('analytics.feedback.submit') + '!' : t('analytics.feedback.skip') + '.'}
      </CardContent>
    </Card>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('analytics.feedback.prompt')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Star rating */}
        <div className="flex items-center gap-1" aria-label="Rate this run">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(0)}
              onClick={() => setRating(n)}
              className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background transition-colors"
            >
              <Star
                className={`h-6 w-6 transition-colors ${
                  n <= (hovered || rating)
                    ? 'text-amber-400 fill-amber-400'
                    : 'text-muted-foreground/30'
                }`}
              />
            </button>
          ))}
        </div>

        {/* Hours saved (optional) */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t('analytics.feedback.hours_saved')}
          </label>
          <Input
            type="number"
            min="0"
            step="0.5"
            value={hoursSaved}
            onChange={(e) => setHoursSaved(e.target.value)}
            placeholder="e.g. 2.5"
            className="w-32"
          />
        </div>

        {/* Business value note (optional) */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t('analytics.feedback.value_note')}
          </label>
          <textarea
            value={valueNote}
            onChange={(e) => setValueNote(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && rating && !submitting) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Any notes on business value or quality…"
            rows={2}
            className="w-full rounded-input border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={!rating || submitting}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('analytics.feedback.submit')}
          </button>
          <button
            type="button"
            onClick={() => setSkipped(true)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2"
          >
            {t('analytics.feedback.skip')}
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Restart node button ────────────────────────────────────────────────────

function RestartNodeButton({ runId, nodeId, onSuccess }: { runId: string; nodeId: string; onSuccess?: () => void }) {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const restart = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/nodes/${nodeId}/gate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ decision: 'replay_from_scratch' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      // Reconnect the SSE stream so we receive PENDING/RUNNING events immediately
      onSuccess?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to restart')
    } finally {
      setLoading(false)
    }
  }, [runId, nodeId, onSuccess])

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={restart}
        disabled={loading}
        title="Restart this agent from scratch"
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium bg-surface-raised border border-surface-border text-muted-foreground hover:text-foreground hover:border-amber-500/60 disabled:opacity-50 transition-colors"
      >
        {loading
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : <RotateCcw className="h-3 w-3" />}
        Restart
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

// ─── Status helpers ─────────────────────────────────────────────────────────

const STATUS_VARIANT = RUN_STATUS_VARIANT

const NODE_STATUS_ICON: Record<string, React.ReactNode> = {
  RUNNING: <Loader2 className="h-3.5 w-3.5 animate-spin text-status-running" />,
  COMPLETED: <CheckCircle2 className="h-3.5 w-3.5 text-status-completed" />,
  FAILED: <XCircle className="h-3.5 w-3.5 text-status-failed" />,
  ESCALATED: <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />,
}

// ─── Node card ──────────────────────────────────────────────────────────────

function NodeCard({ node, runId, canRestart, onRestart, uiLevel }: { node: InitialNode | NodeState; runId: string; canRestart: boolean; onRestart?: () => void; uiLevel: 'GUIDED' | 'STANDARD' | 'ADVANCED' }) {
  const [expanded, setExpanded] = useState(false)
  const streamEndRef = useRef<HTMLPreElement>(null)

  // Auto-scroll streaming panel to bottom as new content arrives
  useEffect(() => {
    if (node.status === 'RUNNING' && node.partial_output && streamEndRef.current) {
      streamEndRef.current.scrollTop = streamEndRef.current.scrollHeight
    }
  }, [node.status, node.partial_output])

  // Elapsed time for in-progress nodes.
  // Initialised to null so SSR and the hydration render both emit nothing —
  // preventing the "server text didn't match client" hydration error that
  // occurs when Date.now() is called inline during render.
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (!node.started_at || node.completed_at) {
      setElapsed(null)
      return
    }
    const startMs = new Date(node.started_at).getTime()
    setElapsed(Math.round((Date.now() - startMs) / 1000))
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startMs) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [node.started_at, node.completed_at])

  const restartable = canRestart && (node.status === 'FAILED' || node.status === 'INTERRUPTED')

  // Parse handoff_out for display
  const handoff = (node.handoff_out as Record<string, unknown> | null) ?? null
  const output  = handoff?.['output'] as Record<string, unknown> | undefined
  const execMeta = handoff?.['execution_meta'] as Record<string, unknown> | undefined
  const outputContent = (output?.['content'] ?? output?.['text'] ?? null) as string | null
  const outputSummary = output?.['summary'] as string | undefined
  const outputType    = output?.['type']    as string | undefined
  const confidence    = output?.['confidence'] as number | undefined
  const llmUsed       = (execMeta?.['llm_used'] ?? node.llm_profile_id) as string | undefined
  const hasOutput     = !!outputContent || !!node.partial_output

  const durationSec = node.started_at && node.completed_at
    ? Math.round((new Date(node.completed_at).getTime() - new Date(node.started_at).getTime()) / 1000)
    : null

  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised text-sm overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-3 p-3">
        <div className="mt-0.5 shrink-0">
          {NODE_STATUS_ICON[node.status] ?? <div className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">
              {node.agent_type}
              <span className="ml-1.5 text-xs text-muted-foreground font-mono">{node.node_id}</span>
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant={STATUS_VARIANT[node.status] ?? 'pending'} className="text-xs">
                {node.status}
              </Badge>
              {hasOutput && (
                <button
                  type="button"
                  onClick={() => setExpanded(v => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded border border-surface-border hover:border-foreground/30"
                >
                  {expanded ? '▲ Hide' : '▼ Output'}
                </button>
              )}
            </div>
          </div>

          {/* Meta row: duration, tokens, cost, model */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
            {elapsed !== null && (
              <span className="text-xs text-muted-foreground">{elapsed}s elapsed</span>
            )}
            {durationSec !== null && (
              <span className="text-xs text-muted-foreground">{durationSec}s</span>
            )}
            {node.tokens_in > 0 && uiLevel !== 'GUIDED' && (
              <span className="text-xs text-muted-foreground font-mono">
                ↑{node.tokens_in.toLocaleString('en')} ↓{node.tokens_out.toLocaleString('en')} tok
              </span>
            )}
            {node.cost_usd > 0 && uiLevel !== 'GUIDED' && (
              <span className="text-xs text-muted-foreground font-mono">€{node.cost_usd.toFixed(4)}</span>
            )}
            {llmUsed && (
              <span className="text-xs text-muted-foreground/60 font-mono truncate max-w-[120px]">{llmUsed}</span>
            )}
            {typeof confidence === 'number' && uiLevel === 'ADVANCED' && (
              <span className={`text-xs font-mono ${confidence >= 80 ? 'text-emerald-400' : confidence >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                {confidence}% conf
              </span>
            )}
          </div>

          {node.error && (
            <p className="text-xs text-red-400 mt-1 line-clamp-3 font-mono">{node.error}</p>
          )}
          {outputSummary && !expanded && (
            <p className="text-xs text-muted-foreground mt-1 italic line-clamp-1">{outputSummary}</p>
          )}
        </div>
      </div>

      {/* Expandable output panel */}
      {expanded && hasOutput && (
        <div className="border-t border-surface-border bg-surface-raised">
          {outputSummary && (
            <div className="px-4 py-2 border-b border-surface-border/50">
              <p className="text-xs text-muted-foreground italic">{outputSummary}</p>
              {outputType && <span className="text-xs text-muted-foreground/50 font-mono">{outputType}</span>}
            </div>
          )}
          <pre className="p-4 text-xs text-foreground/90 font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto leading-relaxed">
            {outputContent ?? (node.partial_output ? extractStreamingContent(node.partial_output) : null)}
          </pre>
        </div>
      )}

      {/* RUNNING: partial output live preview */}
      {node.status === 'RUNNING' && node.partial_output && (
        <div className="border-t border-surface-border/50 bg-surface-raised px-4 py-2">
          <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            <span>Streaming…</span>
            <span className="text-muted-foreground/40 font-mono">{node.partial_output.length} chars</span>
          </p>
          <pre
            ref={streamEndRef}
            className="text-xs text-foreground/80 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed"
          >
            {extractStreamingContent(node.partial_output)}
            <span className="inline-block w-1.5 h-3 bg-foreground/60 animate-pulse ml-0.5 align-middle" />
          </pre>
        </div>
      )}

      {restartable && (
        <div className="border-t border-surface-border/50 px-3 py-2">
          <RestartNodeButton runId={runId} nodeId={node.node_id} onSuccess={onRestart} />
        </div>
      )}
    </div>
  )
}

// ─── Result tab ─────────────────────────────────────────────────────────────

/**
 * Displays the final output of a completed run.
 * Finds terminal nodes (no outgoing DAG edges) and renders their output content
 * as plain text. React JSX text nodes escape automatically — no XSS risk.
 */

/**
 * Heuristic: does the string look like Markdown?
 * Checks for common structural indicators — not exhaustive, just enough to
 * avoid rendering plain prose through the Markdown pipeline.
 */
function looksLikeMarkdown(text: string): boolean {
  return /^#{1,6}\s|^[-*+]\s|^\d+\.\s|^>\s|```|\|.+\||\*\*.+\*\*|__.+__|\[.+\]\(/.test(text)
}

// rehype-sanitize schema: default allowlist, no iframes, no forms, no scripts.
// javascript: URLs stripped automatically by the default schema.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': (defaultSchema.attributes?.['*'] ?? []).filter(
      (a) => typeof a !== 'string' || !a.startsWith('on')
    ),
  },
}

const PRINT_CSS = `
/* Margin strategy — all-browser reliable including Safari:
   LEFT/RIGHT: body { padding: 0 2.5cm } constrains content-box width so every
     line on every page is indented. @page margin-left/right = 0 to avoid double.
   TOP/BOTTOM: CSS table thead/tfoot trick. The browser repeats <thead> and <tfoot>
     natively at the top/bottom of EVERY printed page. Empty cells with a fixed
     height act as per-page top/bottom margins. This works in Safari, Chrome,
     Firefox, Edge — no @page support needed for margins. */
@page { margin: 0; }
*, *::before, *::after { box-sizing: border-box; }
html { margin: 0; padding: 0; background: white; }
body {
  margin: 0;
  padding: 0 2.5cm;
  background: white;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 11pt;
  line-height: 1.65;
  color: #111;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
table.print-layout { width: 100%; border-collapse: collapse; border: none; margin: 0; }
table.print-layout > thead > tr > td,
table.print-layout > tfoot > tr > td { height: 2cm; line-height: 0; font-size: 0; border: none !important; padding: 0 !important; background: transparent !important; }
table.print-layout > tbody > tr > td { border: none !important; padding: 0 !important; background: transparent !important; vertical-align: top; }
h1 { font-size: 20pt; margin: 0 0 14pt; color: #000; }
h2 { font-size: 15pt; margin: 18pt 0 8pt; color: #111; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
h3 { font-size: 12pt; margin: 14pt 0 6pt; color: #111; }
h4, h5, h6 { font-size: 11pt; margin: 10pt 0 4pt; color: #333; }
p { margin: 0 0 8pt; }
ul, ol { padding-left: 20pt; margin: 0 0 8pt; }
li { margin-bottom: 3pt; }
blockquote { border-left: 3px solid #aaa; padding-left: 10pt; color: #444; font-style: italic; margin: 8pt 0; background: transparent; }
code { font-family: Consolas, 'Courier New', monospace; font-size: 9pt; background: #f4f4f4; color: #c00; border: 1px solid #ddd; border-radius: 2px; padding: 0 2pt; }
pre { font-family: Consolas, 'Courier New', monospace; font-size: 8.5pt; background: #f8f8f8; border: 1px solid #ccc; border-radius: 3px; padding: 8pt; white-space: pre-wrap; word-break: break-all; margin: 8pt 0; overflow: visible; }
pre code { background: transparent; border: none; color: inherit; font-size: inherit; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; margin: 8pt 0; }
th, td { border: 1px solid #bbb; padding: 4pt 8pt; text-align: left; background: transparent; }
th { background: #eee; font-weight: 700; }
a { color: #1a56db; text-decoration: underline; }
a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 8pt; color: #666; word-break: break-all; }
h1, h2 { page-break-after: avoid; break-after: avoid; }
pre, blockquote, table { page-break-inside: avoid; break-inside: avoid; }
.section-label { font-family: monospace; font-size: 9pt; color: #666; margin: 0 0 16pt; }
.plain-text { white-space: pre-wrap; word-break: break-word; font-size: 11pt; }
`

function ResultTab({
  nodes,
  dag,
}: {
  nodes: (InitialNode | NodeState)[]
  dag: Dag
}) {
  const printRef = useRef<HTMLDivElement>(null)

  function handlePrint() {
    const container = printRef.current
    if (!container) return

    const cards = Array.from(container.querySelectorAll('[data-output-card]'))
    const sectionsHtml = cards.length > 0
      ? cards.map((card) => {
          const label = card.getAttribute('data-label')
          const content = card.querySelector('[data-output-content]')?.innerHTML ?? ''
          return label
            ? `<p class="section-label">${label}</p>${content}`
            : content
        }).join('<hr style="border:none;border-top:1px solid #eee;margin:16pt 0">')
      : container.innerHTML

    const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run Result</title>
<style>${PRINT_CSS}</style>
</head><body><table class="print-layout">
<thead><tr><td></td></tr></thead>
<tfoot><tr><td></td></tr></tfoot>
<tbody><tr><td>${sectionsHtml}</td></tr></tbody>
</table></body></html>`

    // Use Blob URL instead of document.write() — Safari does not apply @page
    // rules to documents written via document.write() in a popup, but does
    // apply them when the popup navigates to a real URL (including blob:).
    // window.open(blobUrl) must still be called synchronously (no await) to
    // avoid popup blockers on all platforms.
    let blobUrl: string | null = null
    try {
      const blob = new Blob([html], { type: 'text/html' })
      blobUrl = URL.createObjectURL(blob)
    } catch {
      // Blob API unavailable — fall back to document.write
    }

    const win = blobUrl
      ? window.open(blobUrl, '_blank', 'width=900,height=700')
      : window.open('', '_blank', 'width=900,height=700')

    if (!win) {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      window.print() // popup blocked fallback
      return
    }

    // If we couldn't create a blob URL, write directly (non-Safari fallback)
    if (!blobUrl) {
      win.document.write(html)
      win.document.close()
    }

    win.onload = () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      setTimeout(() => {
        win.focus()
        win.print()
        win.onafterprint = () => win.close()
      }, 300)
    }
  }

  // Terminal nodes = nodes that are never the *source* of a dependency edge
  const sourceIds = new Set(dag.edges.map((e) => e.from))
  const terminalIds = new Set(dag.nodes.filter((n) => !sourceIds.has(n.id)).map((n) => n.id))

  // Collect outputs from completed terminal nodes, preserving DAG order
  const terminalOutputs = dag.nodes
    .filter((dn) => terminalIds.has(dn.id))
    .flatMap((dn) => {
      const node = nodes.find((n) => n.node_id === dn.id && n.status === 'COMPLETED')
      if (!node) return []
      const handoff = (node.handoff_out as Record<string, unknown> | null) ?? null
      const output  = handoff?.['output'] as Record<string, unknown> | undefined
      const content = (output?.['content'] ?? output?.['text'] ?? null) as string | null
      if (!content) return []
      return [{ node_id: dn.id, agent_type: dn.agent_type, content }]
    })

  // Fallback: most-recently-completed node that has output text
  const fallbackOutputs = (): Array<{ node_id: string; agent_type: string; content: string }> => {
    const sorted = [...nodes]
      .filter((n) => n.status === 'COMPLETED')
      .sort((a, b) => {
        const ta = a.completed_at ? new Date(a.completed_at).getTime() : 0
        const tb = b.completed_at ? new Date(b.completed_at).getTime() : 0
        return tb - ta
      })
    for (const n of sorted) {
      const handoff = (n.handoff_out as Record<string, unknown> | null) ?? null
      const output  = handoff?.['output'] as Record<string, unknown> | undefined
      const content = (output?.['content'] ?? output?.['text'] ?? null) as string | null
      if (content) return [{ node_id: n.node_id, agent_type: n.agent_type, content }]
    }
    return []
  }

  const outputs = terminalOutputs.length > 0 ? terminalOutputs : fallbackOutputs()

  if (outputs.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-30" />
          <p className="text-sm">No output available for this run.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div data-print-result ref={printRef}>
      {outputs.map((o, i) => (
        <Card
          key={o.node_id}
          data-output-card
          data-label={outputs.length > 1 ? `${o.agent_type} · ${o.node_id}` : undefined}
        >
          {outputs.length > 1 && (
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground font-mono">
                {o.agent_type} · {o.node_id}
              </CardTitle>
            </CardHeader>
          )}
          <CardContent className={outputs.length > 1 ? 'pt-0' : 'pt-6'}>
            <div className="relative">
              {i === 0 && (
                <button
                  type="button"
                  onClick={handlePrint}
                  aria-label="Print / Save as PDF"
                  title="Print / Save as PDF"
                  className="absolute top-0 right-0 inline-flex items-center justify-center h-11 w-11 rounded-md border border-surface-border text-muted-foreground hover:text-foreground hover:border-amber-500/60 hover:bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                >
                  <Printer className="h-4 w-4" />
                </button>
              )}
              {looksLikeMarkdown(o.content) ? (
                <div
                  data-output-content
                  className={`prose prose-sm dark:prose-invert max-w-none text-foreground${i === 0 ? ' pr-14' : ''}`}
                >
                  <ReactMarkdown rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}>
                    {o.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div
                  data-output-content
                  className={`plain-text text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words${i === 0 ? ' pr-14' : ''}`}
                >
                  {o.content}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ─── Activity feed entry ─────────────────────────────────────────────────────

const ACTIVITY_ICONS: Record<string, [emoji: string, label: string]> = {
  error:      ['🔴', 'Error'],
  completed:  ['✅', 'Completed'],
  human_gate: ['⏸', 'Paused'],
}

function ActivityEntry({ type, label }: { type: string; label: string }) {
  const [icon, iconLabel] = ACTIVITY_ICONS[type] ?? ['💬', 'Event']
  return (
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
      <span aria-hidden="true" className="shrink-0">{icon}</span>
      <span className="sr-only">{iconLabel}:</span>
      <span>{label}</span>
    </div>
  )
}

// ─── Run progress bar ───────────────────────────────────────────────────────

function RunProgress({ nodes }: { nodes: (InitialNode | NodeState)[] }) {
  if (nodes.length === 0) return null
  const done = nodes.filter((n) => n.status === 'COMPLETED' || n.status === 'SKIPPED').length
  const pct = Math.round((done / nodes.length) * 100)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{done} / {nodes.length} agents</span>
        <span>{pct}%</span>
      </div>
      <Progress value={pct} />
    </div>
  )
}

// ─── Cost meter ─────────────────────────────────────────────────────────────

function CostMeter({
  costUsd,
  budgetUsd,
  permissions,
}: {
  costUsd: number
  budgetUsd: number | null
  permissions: Set<Permission>
}) {
  // Guard: Prisma Decimal may arrive as a string via SSE if not sanitized upstream
  const cost = Number(costUsd)
  return (
    <PermissionGuard permissions={permissions} permission="runs:read_costs">
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Cost</span>
            <span className="font-mono font-medium text-foreground">€{isNaN(cost) ? '—' : cost.toFixed(4)}</span>
          </div>
          {budgetUsd && (
            <>
              <Progress value={Math.min(100, (cost / Number(budgetUsd)) * 100)} />
              <p className="text-xs text-muted-foreground text-right">
                Budget: €{Number(budgetUsd).toFixed(2)}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </PermissionGuard>
  )
}

// ─── Main client component ──────────────────────────────────────────────────

export function RunDetailClient({ projectId, initialRun, initialNodes, permissions, initialEvents, uiLevel }: Props) {
  const stream = useRunStream(initialRun.id)
  const { reconnect } = stream

  // Use SSE state when available, fall back to initial server-fetched state
  const run = stream.run ?? {
    id: initialRun.id,
    status: initialRun.status as RunStatus,
    cost_actual_usd: initialRun.cost_actual_usd,
    tokens_actual: initialRun.tokens_actual,
    paused_at: initialRun.paused_at,
    started_at: initialRun.started_at,
    completed_at: initialRun.completed_at,
    dag: initialRun.dag,
  }

  const nodes: (InitialNode | NodeState)[] = stream.nodes.length > 0 ? stream.nodes : initialNodes

  const isLive = run.status === 'RUNNING' || run.status === 'PAUSED'
  const isTerminal = run.status === 'COMPLETED' || run.status === 'FAILED'

  // Active tab — defaults to 'result' for completed runs, auto-switches once on completion
  const autoSwitchedRef = useRef(false)
  const [activeTab, setActiveTab] = useState(
    initialRun.status === 'COMPLETED' ? 'result' : 'agents'
  )
  useEffect(() => {
    if (run.status === 'COMPLETED' && !autoSwitchedRef.current) {
      autoSwitchedRef.current = true
      setActiveTab('result')
    }
  }, [run.status])

  // Elapsed run time
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!run.started_at || isTerminal) return
    const update = () => {
      setElapsed(Math.round((Date.now() - new Date(run.started_at!).getTime()) / 1000))
    }
    update()
    const t = setInterval(update, 1000)
    return () => clearInterval(t)
  }, [run.started_at, isTerminal])

  // Gates
  const hasOpenGate = initialRun.openGate || stream.events.some((e) => e.type === 'human_gate')

  return (
    <div className="space-y-6">
      {/* Run header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            {initialRun.task_input && (
              <span className="text-sm font-medium text-foreground truncate max-w-xs" title={initialRun.task_input}>
                {initialRun.task_input.trim().split(/\s+/).slice(0, 8).join(' ')}{initialRun.task_input.trim().split(/\s+/).length > 8 ? '…' : ''}
              </span>
            )}
            <Badge variant={STATUS_VARIANT[run.status] ?? 'pending'} className="text-sm px-3 py-1">
              {run.status}
            </Badge>
            {stream.connected && isLive && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400" aria-live="polite" aria-atomic="true">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                Live
              </span>
            )}
            {stream.error && (
              <span className="text-xs text-amber-400" role="status" aria-live="assertive" aria-atomic="true">{stream.error}</span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground font-mono">{run.id}</p>
          {run.started_at && !isTerminal && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Running for {Math.floor(elapsed / 60)}m {elapsed % 60}s
            </p>
          )}
          {run.completed_at && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Completed {new Date(run.completed_at).toLocaleString('en', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          )}
        </div>

        {/* Controls: Pause + Inject */}
        <div className="flex items-center gap-3 shrink-0">
          <PermissionGuard permissions={permissions} permission="runs:pause">
            <PauseControls runId={run.id} runStatus={run.status} />
          </PermissionGuard>
        </div>
      </div>

      {/* Human gate banner */}
      {hasOpenGate && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-300">Human review required</p>
              {initialRun.openGate?.reason && (
                <p className="text-xs text-amber-400/80 mt-0.5">{initialRun.openGate.reason}</p>
              )}
            </div>
          </div>
          <PermissionGuard permissions={permissions} permission="gates:read">
            <Link
              href={`/projects/${projectId}/runs/${run.id}/gate`}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-amber-400 transition-colors"
            >
              Review <ExternalLink className="h-3 w-3" />
            </Link>
          </PermissionGuard>
        </div>
      )}

      {/* Main content: progress + nodes + activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: agent nodes */}
        <div className="lg:col-span-2 space-y-4">
          <RunProgress nodes={nodes} />

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="overflow-x-auto">
            <TabsList>
              {run.status === 'COMPLETED' && (
                <TabsTrigger value="result">Result</TabsTrigger>
              )}
              <TabsTrigger value="agents">Agents ({nodes.length})</TabsTrigger>
              <TabsTrigger value="dag">DAG</TabsTrigger>
              <TabsTrigger value="activity">Activity ({stream.events.length + initialEvents.length})</TabsTrigger>
              {initialRun.transparency_mode && (
                <TabsTrigger value="inject">Inject context</TabsTrigger>
              )}
            </TabsList>
            </div>

            {run.status === 'COMPLETED' && (
              <TabsContent value="result">
                <ResultTab nodes={nodes} dag={initialRun.dag} />
              </TabsContent>
            )}

            <TabsContent value="agents">
              <div className="space-y-2">
                {nodes.length === 0 ? (
                  <Card>
                    <CardContent className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                      Waiting for agents to start…
                    </CardContent>
                  </Card>
                ) : (
                  nodes.map((node) => <NodeCard key={node.id} node={node} runId={run.id} canRestart={permissions.has('runs:replay')} onRestart={reconnect} uiLevel={uiLevel} />)
                )}
              </div>
            </TabsContent>

            <TabsContent value="dag">
              <DagView
                dag={initialRun.dag}
                nodeStates={Object.fromEntries(
                  nodes.map(n => [n.node_id, {
                    status:          n.status,
                    cost_usd:        ('cost_usd'        in n ? n.cost_usd        : undefined),
                    error:           ('error'           in n ? n.error ?? undefined : undefined),
                    tokens_in:       ('tokens_in'       in n ? n.tokens_in       : undefined),
                    tokens_out:      ('tokens_out'      in n ? n.tokens_out      : undefined),
                    started_at:      ('started_at'      in n ? n.started_at      : undefined),
                    completed_at:    ('completed_at'    in n ? n.completed_at    : undefined),
                    llm_profile_id:  ('llm_profile_id'  in n ? n.llm_profile_id  : undefined),
                    partial_output:  ('partial_output'  in n ? n.partial_output  : undefined),
                    handoff_out:     ('handoff_out'     in n ? n.handoff_out     : undefined),
                  }]),
                )}
                onRestartNode={permissions.has('runs:replay') ? (nodeId) => {
                  fetch(`/api/runs/${run.id}/nodes/${nodeId}/gate`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ decision: 'replay_from_scratch' }),
                  }).then(() => reconnect()).catch(console.error)
                } : undefined}
              />
            </TabsContent>

            <TabsContent value="activity">
              <Card>
                <CardContent className="p-4 space-y-2 max-h-80 overflow-y-auto">
                  {/* Live SSE events (newest first) */}
                  {stream.events.slice().reverse().map((ev, i) => {
                    const label =
                      ev.type === 'state_change'
                        ? `${ev.entity_type} ${ev.id?.slice(0, 6)} → ${ev.status}`
                        : ev.type === 'cost_update'
                        ? `Cost: €${Number(ev.cost_usd).toFixed(4)}`
                        : ev.type === 'error'
                        ? `Error in ${ev.node_id}: ${ev.message}`
                        : ev.type === 'human_gate'
                        ? `Human gate: ${ev.reason}`
                        : ev.type === 'completed'
                        ? 'Run completed'
                        : ev.type
                    return <ActivityEntry key={`live-${ev.type}-${i}`} type={ev.type} label={label} />
                  })}

                  {/* Historical AuditLog entries (newest first) */}
                  {initialEvents.length > 0 && (
                    <>
                      {stream.events.length > 0 && (
                        <div className="border-t border-border my-2" />
                      )}
                      {initialEvents.slice().reverse().map((log) => {
                        const payload = log.payload ?? {}
                        const from = payload.from as string | undefined
                        const to   = payload.to   as string | undefined
                        const entity = payload.entity as string | undefined
                        const label =
                          log.action_type === 'state_transition'
                            ? `${entity ?? log.node_id ?? 'run'} ${from} → ${to}`
                            : `${log.action_type}${log.node_id ? ` (${log.node_id})` : ''}`
                        const type =
                          to === 'COMPLETED' ? 'completed'
                          : to === 'FAILED'  ? 'error'
                          : to === 'PAUSED'  ? 'human_gate'
                          : 'state_change'
                        const ts = new Date(log.timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        return (
                          <ActivityEntry key={log.id} type={type} label={`[${ts}] ${label}`} />
                        )
                      })}
                    </>
                  )}

                  {stream.events.length === 0 && initialEvents.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">No events yet.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {initialRun.transparency_mode && (
              <TabsContent value="inject">
                <PermissionGuard permissions={permissions} permission="runs:inject">
                  <ContextInjectionPanel runId={run.id} runStatus={run.status} />
                </PermissionGuard>
              </TabsContent>
            )}
          </Tabs>
        </div>

        {/* Right: cost meter + run info */}
        <div className="space-y-4">
          {uiLevel !== 'GUIDED' && (
            <CostMeter
              costUsd={run.cost_actual_usd}
              budgetUsd={initialRun.budget_usd}
              permissions={permissions}
            />
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Run info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Tokens</span>
                <span className="font-mono">{run.tokens_actual.toLocaleString('en')}</span>
              </div>
              {run.started_at && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Started</span>
                  <span className="font-mono text-xs">
                    {new Date(run.started_at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">DAG nodes</span>
                <span className="font-mono">{initialRun.dag.nodes.length}</span>
              </div>
            </CardContent>
          </Card>

          {run.status === 'COMPLETED' && (
            <FeedbackPanel runId={run.id} />
          )}
        </div>
      </div>
    </div>
  )
}
