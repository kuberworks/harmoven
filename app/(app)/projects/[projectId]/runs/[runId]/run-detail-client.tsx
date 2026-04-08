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
import { AlertTriangle, CheckCircle2, XCircle, Loader2, ExternalLink, Star, RotateCcw, FileText, Printer, Download, Globe } from 'lucide-react'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
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

interface ArtifactMeta {
  id: string
  node_id: string | null
  filename: string
  mime_type: string
  size_bytes: number
  created_at: string
  expires_at: string | null
  artifact_role: 'pending_review' | 'primary' | 'supplementary' | 'discarded'
}

interface Props {
  projectId: string
  initialRun: InitialRun
  initialNodes: InitialNode[]
  permissions: Set<Permission>
  initialEvents: AuditEntry[]
  uiLevel: 'GUIDED' | 'STANDARD' | 'ADVANCED'
  chain?: {
    parents:  { id: string; status: string; task_input: string | null; output_summary?: string | null }[]
    children: { id: string; status: string; task_input: string | null }[]
  }
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

function RestartNodeButton({ runId, nodeId, onSuccess, isRerun }: { runId: string; nodeId: string; onSuccess?: () => void; isRerun?: boolean }) {
  const t = useT()
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
        {isRerun ? t('run.node.rerun') : t('run.node.restart')}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}

// ─── Status helpers ─────────────────────────────────────────────────────────

// ─── Re-run reviewer button ──────────────────────────────────────────────────

function ReRunReviewerButton({ runId, onSuccess }: { runId: string; onSuccess?: () => void }) {
  const t = useT()
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const trigger = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/re-review`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      onSuccess?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to re-run reviewer')
    } finally {
      setLoading(false)
    }
  }, [runId, onSuccess])

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={trigger}
        disabled={loading}
        className="flex items-center justify-center gap-1.5 w-full rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:border-amber-500/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading
          ? <><Loader2 className="h-3 w-3 animate-spin" />{t('runs.reReview.loading')}</>
          : <><RotateCcw className="h-3 w-3" />{t('runs.reReview.label')}</>}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

const STATUS_VARIANT = RUN_STATUS_VARIANT

const NODE_STATUS_ICON: Record<string, React.ReactNode> = {
  RUNNING: <Loader2 className="h-3.5 w-3.5 animate-spin text-status-running" />,
  COMPLETED: <CheckCircle2 className="h-3.5 w-3.5 text-status-completed" />,
  FAILED: <XCircle className="h-3.5 w-3.5 text-status-failed" />,
  ESCALATED: <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />,
}

// ─── Node card ──────────────────────────────────────────────────────────────

function NodeCard({ node, runId, projectId, canRestart, onRestart, uiLevel, artifactsTick = 0, followupRuns = [], webSearchProgress = null }: { node: InitialNode | NodeState; runId: string; projectId: string; canRestart: boolean; onRestart?: () => void; uiLevel: 'GUIDED' | 'STANDARD' | 'ADVANCED'; artifactsTick?: number; followupRuns?: Array<{ run_id: string; label: string }>; webSearchProgress?: { query?: string; result_count?: number; iteration: number } | null }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const streamEndRef = useRef<HTMLPreElement>(null)

  const [artifacts, setArtifacts] = useState<ArtifactMeta[] | null>(null)
  useEffect(() => {
    if (node.status !== 'COMPLETED' && artifactsTick === 0) return
    fetch(`/api/runs/${runId}/artifacts`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((all: ArtifactMeta[]) => setArtifacts(all.filter(a => a.node_id === node.node_id && a.artifact_role !== 'discarded')))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.status, artifactsTick])

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

  const restartable = canRestart && (node.status === 'FAILED' || node.status === 'INTERRUPTED' || node.status === 'COMPLETED')

  // Parse handoff_out for display
  const handoff = (node.handoff_out as Record<string, unknown> | null) ?? null
  const output  = handoff?.['output'] as Record<string, unknown> | undefined
  const execMeta = handoff?.['execution_meta'] as Record<string, unknown> | undefined
  // formatted_content is set by the REVIEWER when writer outputs lacked Markdown structure.
  // It takes lowest priority — shown only when output.content / output.text are absent.
  const formattedContent = (handoff?.['formatted_content'] as string | undefined) ?? null
  const outputContent = (output?.['content'] ?? output?.['text'] ?? formattedContent ?? null) as string | null
  const outputSummary = output?.['summary'] as string | undefined
  const outputType    = output?.['type']    as string | undefined
  const confidence    = output?.['confidence'] as number | undefined
  const llmUsed       = (execMeta?.['llm_used'] ?? node.llm_profile_id) as string | undefined
  // PYTHON_EXECUTOR stores output in handoff.stdout rather than handoff.output.content
  const stdout           = (handoff?.['stdout'] as string | undefined) ?? null
  // PYTHON_EXECUTOR — extract error/stderr from handoff for display (exit_code=1 case)
  const pythonExecError  = node.agent_type === 'PYTHON_EXECUTOR'
    ? ((handoff?.['error'] as string | undefined) ?? null)
    : null
  const pythonStderr     = node.agent_type === 'PYTHON_EXECUTOR'
    ? ((handoff?.['stderr'] as string | undefined) ?? null) || null
    : null
  // PYTHON_EXECUTOR — files written by the script but excluded from collection (persisted in handoff_out)
  const pythonSkippedFiles = node.agent_type === 'PYTHON_EXECUTOR' && node.status === 'COMPLETED'
    ? ((handoff?.['skipped_files'] as Array<{ name: string; reason: string }> | undefined) ?? [])
    : []
  const hasOutput     = !!outputContent || !!node.partial_output || !!stdout || !!pythonExecError || !!pythonStderr
  // The settled text shown in the expanded panel (not stdout, not streaming)
  const outputText    = outputContent
    ?? (node.partial_output ? extractStreamingContent(node.partial_output) : null)
    ?? null
  // Rendering mode — driven by the planner-set output.type first; heuristic only as fallback.
  // document           → ReactMarkdown
  // python_code / code / python_files → monospace pre (code block)
  // absent type        → looksLikeMarkdown() heuristic
  const renderAsMarkdown = !!outputText && (
    outputType === 'document' ||
    (!outputType && looksLikeMarkdown(outputText))
  )
  const renderAsCode = !!outputText && !renderAsMarkdown && (
    outputType === 'python_code' || outputType === 'code' || outputType === 'python_files'
  )

  // Only compute a settled duration when the node is not RUNNING.
  // When a node is restarted, completed_at is the timestamp from the *previous* run;
  // using it produces a near-zero (or negative) delta → "<1s" while the node is live.
  const durationMs = node.started_at && node.completed_at && node.status !== 'RUNNING'
    ? new Date(node.completed_at).getTime() - new Date(node.started_at).getTime()
    : null
  const durationSec = durationMs !== null ? Math.round(durationMs / 1000) : null
  const durationLabel = durationMs === null ? null : durationMs < 1000 ? '<1s' : `${durationSec}s`

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
            {durationLabel !== null && (
              <span className="text-xs text-muted-foreground">{durationLabel}</span>
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

          {node.error && (node.status === 'FAILED' || node.status === 'INTERRUPTED') && (
            <p className="text-xs text-red-400 mt-1 line-clamp-3 font-mono">{node.error}</p>
          )}
          {/* PYTHON_EXECUTOR: show Python exception from handoff on COMPLETED nodes (legacy/compat) */}
          {!node.error && pythonExecError && node.status === 'COMPLETED' && (
            <p className="text-xs text-red-400 mt-1 line-clamp-2 font-mono">{pythonExecError}</p>
          )}
          {/* PYTHON_EXECUTOR: skipped files warning — always visible in header */}
          {pythonSkippedFiles.length > 0 && (
            <p className="text-xs text-amber-400 mt-1">
              ⚠ {t('run.node.python_executor.skipped_files.summary', { count: String(pythonSkippedFiles.length) })}
            </p>
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
          {outputText && renderAsMarkdown && (
            <div className="p-4 prose prose-sm dark:prose-invert max-w-none text-foreground/90 [&_pre]:bg-surface-raised [&_pre]:border [&_pre]:border-surface-border [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:font-mono [&_code]:text-xs">
              <ReactMarkdown rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}>
                {outputText}
              </ReactMarkdown>
            </div>
          )}
          {outputText && renderAsCode && (
            <pre className="p-4 text-xs text-foreground/90 font-mono whitespace-pre-wrap break-words leading-relaxed">
              {outputText}
            </pre>
          )}
          {outputText && !renderAsMarkdown && !renderAsCode && (
            <pre className="p-4 text-xs text-foreground/90 whitespace-pre-wrap break-words leading-relaxed">
              {outputText}
            </pre>
          )}
          {!outputText && stdout && (
            <pre className="p-4 text-xs text-foreground/90 font-mono whitespace-pre-wrap break-words leading-relaxed">
              {stdout}
            </pre>
          )}
          {/* PYTHON_EXECUTOR: error + stderr panel */}
          {(pythonExecError || (pythonStderr && pythonStderr.trim())) && (
            <div className="border-t border-red-500/20 bg-red-950/20 p-4 space-y-2">
              {pythonExecError && (
                <pre className="text-xs text-red-400 font-mono whitespace-pre-wrap break-words leading-relaxed">
                  {pythonExecError}
                </pre>
              )}
              {pythonStderr && pythonStderr.trim() && pythonStderr !== pythonExecError && (
                <details className="group">
                  <summary className="text-xs text-red-400/60 cursor-pointer select-none hover:text-red-400/80 mb-1">
                    Traceback
                  </summary>
                  <pre className="text-xs text-red-400/50 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-64 overflow-y-auto">
                    {pythonStderr}
                  </pre>
                </details>
              )}
            </div>
          )}
          {/* PYTHON_EXECUTOR: skipped files detail list — shown in expanded panel */}
          {pythonSkippedFiles.length > 0 && (
            <div className="border-t border-amber-500/20 bg-amber-950/10 px-4 py-3">
              <p className="text-xs text-amber-400 font-medium mb-1.5">
                ⚠ {t('run.node.python_executor.skipped_files.title')}
              </p>
              <ul className="space-y-0.5">
                {pythonSkippedFiles.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-amber-400/70 font-mono">
                    <span className="truncate">{f.name}</span>
                    <span className="shrink-0 text-amber-400/40">
                      — {t(`run.node.python_executor.skipped_files.reason.${f.reason}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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

      {/* RUNNING: web search progress */}
      {node.status === 'RUNNING' && webSearchProgress && (
        <div className="border-t border-surface-border/50 bg-surface-raised px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Globe className="h-3 w-3 animate-pulse shrink-0" />
          <span>
            {webSearchProgress.query
              ? t('run.node.web_search.searching', { query: webSearchProgress.query })
              : t('run.node.web_search.in_progress')}
          </span>
          {webSearchProgress.result_count != null && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
              {webSearchProgress.result_count} {t('run.node.web_search.results')}
            </Badge>
          )}
        </div>
      )}

      {/* Follow-up pipelines spawned by this REVIEWER node (SPAWN_FOLLOWUP verdict) */}
      {node.agent_type === 'REVIEWER' && followupRuns.length > 0 && (
        <div className="border-t border-surface-border px-4 py-3 space-y-2">
          <p className="text-xs text-muted-foreground font-medium">
            {t('run.node.reviewer.followupRuns.title')}
          </p>
          {followupRuns.map(r => (
            <Link
              key={r.run_id}
              href={`/projects/${projectId}/runs/${r.run_id}`}
              className="flex items-center gap-2 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{r.label}</span>
            </Link>
          ))}
        </div>
      )}

      {artifacts && artifacts.length > 0 && (
        <div className="border-t border-surface-border px-4 py-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground font-medium">
              {t('run.node.artifacts.title')}
            </p>
            <a
              href={`/api/runs/${runId}/artifacts/zip?node_id=${node.node_id}`}
              download
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Download className="h-3 w-3" />
              {t('run.node.artifacts.downloadZip')}
            </a>
          </div>
          {artifacts.map(a => (
            <a
              key={a.id}
              href={`/api/runs/${runId}/artifacts/${a.id}`}
              download={a.filename}
              className="flex items-center gap-2 text-xs text-primary hover:underline"
            >
              <Download className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{a.filename}</span>
              <span className="text-muted-foreground/50 shrink-0">
                {(a.size_bytes / 1024).toFixed(1)} KB
              </span>
            </a>
          ))}
        </div>
      )}

      {restartable && (
        <div className="border-t border-surface-border/50 px-3 py-2">
          <RestartNodeButton runId={runId} nodeId={node.node_id} onSuccess={onRestart} isRerun={node.status === 'COMPLETED'} />
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
  // Use multiline flag so ^ matches the start of ANY line, not just the string.
  // Writers often open with a plain-text intro sentence before the first heading.
  return /^#{1,6}\s|^[-*+]\s|^\d+\.\s|^>\s|```|\|.+\||\*\*.+\*\*|__.+__|\[.+\]\(/m.test(text)
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
  runId,
  runStatus,
  artifactReadyTick = 0,
}: {
  nodes: (InitialNode | NodeState)[]
  dag: Dag
  runId: string
  runStatus: string
  artifactReadyTick?: number
}) {
  const t = useT()
  const printRef = useRef<HTMLDivElement>(null)

  // Fetch all artifacts for this run (binary files from PYTHON_EXECUTOR or HTML WRITER outputs).
  // We try for any completed run — not just when PYTHON_EXECUTOR is present — because
  // WRITER nodes that produce HTML are also stored as RunArtifact rows via detectArtifactFormat.
  const [runArtifacts, setRunArtifacts] = useState<ArtifactMeta[]>([])
  // Use count so the effect re-runs each time a new node completes.
  // A boolean would stay `true` after the PLANNER finishes and never
  // re-trigger when the WRITER (the actual artifact producer) completes.
  const completedCount = nodes.filter(n => n.status === 'COMPLETED').length
  useEffect(() => {
    if (completedCount === 0 && artifactReadyTick === 0) return
    fetch(`/api/runs/${runId}/artifacts`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((all: ArtifactMeta[]) => setRunArtifacts(all.filter(a => a.artifact_role !== 'discarded')))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, completedCount, artifactReadyTick])

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

  type OutputEntry = { node_id: string; agent_type: string; content: string; isMarkdown?: boolean }

  // Priority 1: reviewer produced formatted_content (reformatted plain-text → Markdown)
  const reviewerFormatted: OutputEntry[] = dag.nodes.flatMap((dn) => {
    if (dn.agent_type !== 'REVIEWER') return []
    const node = nodes.find((n) => n.node_id === dn.id && n.status === 'COMPLETED')
    if (!node) return []
    const handoff = (node.handoff_out as Record<string, unknown> | null) ?? null
    const fc = (handoff?.['formatted_content'] as string | null) ?? null
    if (!fc) return []
    return [{ node_id: dn.id, agent_type: dn.agent_type, content: fc, isMarkdown: true }]
  })

  // Priority 2: terminal nodes (no outgoing edges), text or stdout content
  const terminalOutputs: OutputEntry[] = dag.nodes
    .filter((dn) => terminalIds.has(dn.id))
    .flatMap((dn) => {
      const node = nodes.find((n) => n.node_id === dn.id && n.status === 'COMPLETED')
      if (!node) return []
      const handoff = (node.handoff_out as Record<string, unknown> | null) ?? null
      const output  = handoff?.['output'] as Record<string, unknown> | undefined
      // PYTHON_EXECUTOR: output lives in handoff.stdout
      const stdout  = (handoff?.['stdout'] as string | undefined) ?? null
      const content = (output?.['content'] ?? output?.['text'] ?? stdout ?? null) as string | null
      if (!content) return []
      return [{ node_id: dn.id, agent_type: dn.agent_type, content }]
    })

  // Priority 3 (fallback): completed WRITER nodes only, in DAG order.
  // Excludes non-terminal and non-WRITER nodes (e.g. PYTHON_EXECUTOR, CLASSIFIER) so
  // we never surface intermediate code or raw execution metadata as the final result.
  // Also excludes WRITER nodes whose direct successor is PYTHON_EXECUTOR — those are
  // intermediate python_code generators, not final output.
  const fallbackOutputs = (): OutputEntry[] => {
    // Collect IDs of PYTHON_EXECUTOR nodes, then find WRITER nodes that feed directly into them.
    const pythonExecIds = new Set(dag.nodes.filter(n => n.agent_type === 'PYTHON_EXECUTOR').map(n => n.id))
    const pythonCodeWriterIds = new Set(dag.edges.filter(e => pythonExecIds.has(e.to)).map(e => e.from))
    return dag.nodes
      .filter((dn) => dn.agent_type === 'WRITER' && !pythonCodeWriterIds.has(dn.id))
      .flatMap((dn) => {
        const node = nodes.find((n) => n.node_id === dn.id && n.status === 'COMPLETED')
        if (!node) return []
        const handoff = (node.handoff_out as Record<string, unknown> | null) ?? null
        const output  = handoff?.['output'] as Record<string, unknown> | undefined
        const content = (output?.['content'] ?? output?.['text'] ?? null) as string | null
        if (!content) return []
        return [{ node_id: dn.id, agent_type: dn.agent_type, content }]
      })
  }

  const outputs: OutputEntry[] =
    reviewerFormatted.length > 0 ? reviewerFormatted
    : terminalOutputs.length  > 0 ? terminalOutputs
    : fallbackOutputs()

  // Collect skipped files from all COMPLETED PYTHON_EXECUTOR nodes in the run.
  // Persisted in handoff_out.skipped_files — survives page reload.
  type SkippedEntry = { name: string; reason: string }
  const allSkippedFiles: SkippedEntry[] = dag.nodes
    .filter(dn => dn.agent_type === 'PYTHON_EXECUTOR')
    .flatMap(dn => {
      const node = nodes.find(n => n.node_id === dn.id && n.status === 'COMPLETED')
      if (!node) return []
      const handoff = (node.handoff_out as Record<string, unknown> | null) ?? null
      return (handoff?.['skipped_files'] as SkippedEntry[] | undefined) ?? []
    })

  // Only show "no output" when there are truly no artifacts and no skipped-file warnings either.
  if (outputs.length === 0 && runArtifacts.length === 0 && allSkippedFiles.length === 0) {
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
      {/* Primary artifact banner */}
      {(() => {
        const primaryArtifact = runArtifacts.find(a => a.artifact_role === 'primary')
        if (!primaryArtifact || runStatus !== 'COMPLETED') return null
        const ext = primaryArtifact.filename.split('.').pop()?.toLowerCase() ?? ''
        const bannerTitle =
          ['docx', 'pdf', 'txt'].includes(ext) ? t('run.result.banner.document')
          : ['csv', 'xlsx'].includes(ext)       ? t('run.result.banner.spreadsheet')
          : ['py', 'js', 'ts', 'sh'].includes(ext) ? t('run.result.banner.script')
          : t('run.result.banner.file')
        const sizeLabel = primaryArtifact.size_bytes < 1024
          ? `${primaryArtifact.size_bytes} B`
          : primaryArtifact.size_bytes < 1024 * 1024
          ? `${(primaryArtifact.size_bytes / 1024).toFixed(1)} KB`
          : `${(primaryArtifact.size_bytes / (1024 * 1024)).toFixed(1)} MB`
        return (
          <Alert variant="success" className="mb-4">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>{bannerTitle}</AlertTitle>
            <AlertDescription className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-medium">{primaryArtifact.filename}</span>
              <span className="text-muted-foreground">{sizeLabel}</span>
              <a
                href={`/api/runs/${runId}/artifacts/${primaryArtifact.id}`}
                download={primaryArtifact.filename}
                className="ml-auto inline-flex items-center gap-1 rounded-md bg-[var(--color-status-completed)] px-2.5 py-1 text-xs font-semibold text-black hover:opacity-90 transition-opacity"
              >
                <Download className="h-3 w-3" />
                {t('run.result.download')}
              </a>
            </AlertDescription>
          </Alert>
        )
      })()}
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
              {(o.isMarkdown || looksLikeMarkdown(o.content)) ? (
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

      {/* Downloadable files */}
      {runArtifacts.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Download className="h-4 w-4 text-muted-foreground" />
                {t('run.result.artifacts.title')}
              </span>
              {runArtifacts.length >= 1 && (
                <a
                  href={`/api/runs/${runId}/artifacts/zip`}
                  download
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Download className="h-3 w-3" />
                  {t('run.node.artifacts.downloadZip')}
                </a>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {runArtifacts.map(a => (
              <div key={a.id} className="space-y-1">
                {a.mime_type.startsWith('image/') && (
                  <img
                    src={`/api/runs/${runId}/artifacts/${a.id}/preview`}
                    alt={a.filename}
                    className="max-h-48 rounded-md object-contain border border-surface-border"
                  />
                )}
                <a
                  href={`/api/runs/${runId}/artifacts/${a.id}`}
                  download={a.filename}
                  className="flex items-center gap-2 text-sm text-primary hover:underline py-0.5"
                >
                  <Download className="h-4 w-4 shrink-0" />
                  <span className="truncate font-medium">{a.filename}</span>
                  <span className="text-xs text-muted-foreground/60 shrink-0 ml-auto">
                    {a.size_bytes < 1024
                      ? `${a.size_bytes} B`
                      : a.size_bytes < 1024 * 1024
                      ? `${(a.size_bytes / 1024).toFixed(1)} KB`
                      : `${(a.size_bytes / (1024 * 1024)).toFixed(1)} MB`}
                  </span>
                </a>
                {a.expires_at && (
                  <span className="text-xs text-muted-foreground">
                    {t('run.result.artifact.expires', { date: new Date(a.expires_at).toLocaleDateString() })}
                  </span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {/* Skipped files warning — shown when the Python executor silently dropped files */}
      {allSkippedFiles.length > 0 && runStatus === 'COMPLETED' && (
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {t('run.result.skipped_files.title', { count: String(allSkippedFiles.length) })}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground mb-2">{t('run.result.skipped_files.description')}</p>
            <ul className="space-y-1">
              {allSkippedFiles.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs font-mono text-amber-400/80">
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    — {t(`run.node.python_executor.skipped_files.reason.${f.reason}`)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ─── Activity feed entry ─────────────────────────────────────────────────────

const ACTIVITY_ICONS: Record<string, [emoji: string, label: string]> = {
  error:         ['🔴', 'Error'],
  completed:     ['✅', 'Completed'],
  human_gate:    ['⏸', 'Paused'],
  node_snapshot: ['⚙', 'Agent update'],
}

const AGENT_TYPE_LABEL: Record<string, string> = {
  CLASSIFIER: 'Classifier',
  PLANNER:    'Planner',
  WRITER:     'Writer',
  REVIEWER:   'Reviewer',
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

export function RunDetailClient({ projectId, initialRun, initialNodes, permissions, initialEvents, uiLevel, chain }: Props) {
  const t = useT()
  const stream = useRunStream(initialRun.id)
  const { reconnect } = stream

  // Cache the last non-null run and nodes from the SSE state.
  // This prevents a RESET (triggered by reconnect after a clean es.close()) from
  // reverting the UI to `initialRun` (which has status='RUNNING' if the page was
  // loaded mid-run) and hiding the conditionally-rendered 'result' tab.
  const lastRunRef   = useRef<RunState | null>(null)
  const lastNodesRef = useRef<NodeState[]>([])
  if (stream.run)                lastRunRef.current   = stream.run
  if (stream.nodes.length > 0)  lastNodesRef.current = stream.nodes

  // Use last-known SSE state when available, fall back to initial server-fetched state
  const run = lastRunRef.current ?? {
    id: initialRun.id,
    status: initialRun.status as RunStatus,
    cost_actual_usd: initialRun.cost_actual_usd,
    tokens_actual: initialRun.tokens_actual,
    paused_at: initialRun.paused_at,
    started_at: initialRun.started_at,
    completed_at: initialRun.completed_at,
    dag: initialRun.dag,
  }

  const nodes: (InitialNode | NodeState)[] = lastNodesRef.current.length > 0 ? lastNodesRef.current : initialNodes

  // SUSPENDED is also "live" — the run is awaiting human approval and will resume.
  const isLive = run.status === 'RUNNING' || run.status === 'PAUSED' || run.status === 'SUSPENDED'
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

  // Gate banner: shown whenever the run is SUSPENDED or PAUSED — the executor
  // always transitions to SUSPENDED before emitting human_gate, so basing this
  // purely on run.status avoids the race condition where the state_change(SUSPENDED)
  // arrives before the human_gate event and the banner fails to appear on first render.
  const hasOpenGate = run.status === 'SUSPENDED' || run.status === 'PAUSED'

  // Gate reason — prefer the live SSE event reason (for gates opened after page load),
  // fall back to the server-fetched initialRun.openGate (for gates already open on load).
  const liveGateEvent = stream.events.findLast?.((e) => e.type === 'human_gate') ??
    stream.events.filter((e) => e.type === 'human_gate').at(-1)
  const gateReason = (liveGateEvent as { type: 'human_gate'; reason: string } | undefined)?.reason
    ?? initialRun.openGate?.reason

  return (
    <div className="space-y-6">
      {/* Run header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {initialRun.task_input && (
            <p className="text-base font-semibold text-foreground whitespace-pre-wrap break-words leading-snug mb-2">
              {initialRun.task_input}
            </p>
          )}
          <div className="flex items-center gap-3">
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
              {gateReason && (
                <p className="text-xs text-amber-400/80 mt-0.5">{gateReason}</p>
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
                <ResultTab nodes={nodes} dag={run.dag} runId={run.id} runStatus={run.status} artifactReadyTick={stream.events.filter(e => e.type === 'artifact_ready').length} />
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
                  nodes.map((node) => (
                    <NodeCard
                      key={node.id}
                      node={node}
                      runId={run.id}
                      projectId={projectId}
                      canRestart={permissions.has('runs:replay')}
                      onRestart={reconnect}
                      uiLevel={uiLevel}
                      artifactsTick={stream.events.filter(e => e.type === 'artifacts_ready' && e.node_id === node.node_id).length}
                      webSearchProgress={(() => {
                        const last = stream.events.findLast?.(e => e.type === 'tool_call_progress' && e.node_id === node.node_id)
                          ?? stream.events.filter(e => e.type === 'tool_call_progress' && e.node_id === node.node_id).at(-1)
                        return last && last.type === 'tool_call_progress' ? { query: last.query, result_count: last.result_count, iteration: last.iteration } : null
                      })()}
                      followupRuns={(
                        stream.events
                          .filter(e => e.type === 'spawned_followup_runs' && e.node_id === node.node_id)
                          .flatMap(e => e.type === 'spawned_followup_runs' ? e.runs : [])
                      )}
                    />
                  ))
                )}
              </div>
            </TabsContent>

            <TabsContent value="dag">
              <DagView
                dag={run.dag}
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
                  {stream.events.slice().reverse().flatMap((ev, i) => {
                    if (ev.type === 'node_snapshot') {
                      // Skip pure streaming noise (partial_output only)
                      if (Object.keys(ev.data).length === 1 && 'partial_output' in ev.data) return []
                      const nd = nodes.find(n => n.node_id === ev.node_id)
                      const name = nd
                        ? `${AGENT_TYPE_LABEL[nd.agent_type] ?? nd.agent_type} (${ev.node_id})`
                        : ev.node_id
                      const d = ev.data
                      const snapshotLabel =
                        'llm_profile_id' in d && d.llm_profile_id ? `${name} — model: ${d.llm_profile_id as string}`
                        : 'started_at'   in d && d.started_at     ? `${name} — started`
                        : d.status === 'INTERRUPTED'               ? `${name} — interrupted`
                        : 'cost_usd' in d || 'tokens_in' in d     ? `${name} — output ready`
                        : `${name} — updated`
                      return [<ActivityEntry key={`live-${ev.type}-${i}`} type={ev.type} label={snapshotLabel} />]
                    }
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
                    return [<ActivityEntry key={`live-${ev.type}-${i}`} type={ev.type} label={label} />]
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
                <span className="font-mono">{run.dag.nodes.length}</span>
              </div>
            </CardContent>
          </Card>

          {/* Run chain */}
          {(chain?.parents ?? []).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">⛓ {t('runs.chain.chainedFrom')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                {chain!.parents.map(p => (
                  <div key={p.id} className="flex flex-col gap-0.5">
                    <Link
                      href={`/projects/${projectId}/runs/${p.id}`}
                      className="flex items-center justify-between gap-2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="font-mono truncate">{p.id.slice(0, 8)}</span>
                      <Badge variant={STATUS_VARIANT[p.status as RunStatus] ?? 'pending'} className="text-[10px]">{p.status}</Badge>
                    </Link>
                    {p.output_summary && (
                      <p className="text-muted-foreground line-clamp-3 text-[11px] pl-1">
                        {p.output_summary}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {run.status === 'COMPLETED' && (
            <Link
              href={`/projects/${projectId}/runs/new?from=${run.id}`}
              className="flex items-center justify-center gap-1.5 w-full rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:border-amber-500/40 transition-colors"
            >
              ⛓ {t('runs.chain.chainNewRun')}
            </Link>
          )}

          {(chain?.children ?? []).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  ↓ {chain!.children.length} {chain!.children.length > 1 ? t('runs.chain.runsChained') : t('runs.chain.runChained')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                {chain!.children.map(c => (
                  <Link
                    key={c.id}
                    href={`/projects/${projectId}/runs/${c.id}`}
                    className="flex items-center justify-between gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <span className="font-mono truncate">{c.id.slice(0, 8)}</span>
                    <Badge variant={STATUS_VARIANT[c.status as RunStatus] ?? 'pending'} className="text-[10px]">{c.status}</Badge>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {run.status === 'COMPLETED' && permissions.has('runs:replay') && run.dag.nodes.some(n => n.agent_type === 'REVIEWER') && (
            <ReRunReviewerButton
              runId={run.id}
              onSuccess={() => { reconnect(); setActiveTab('agents') }}
            />
          )}

          {run.status === 'COMPLETED' && (
            <FeedbackPanel runId={run.id} />
          )}
        </div>
      </div>
    </div>
  )
}
