'use client'

// app/(app)/projects/[projectId]/runs/[runId]/run-detail-client.tsx
// Live run view — SSE-powered, progressive disclosure levels.
// Receives initial state from Server Component, wires up useRunStream for updates.
// UX spec §3.5 — ExecutingView (Level 1–4), CompletedView, ProblemView.

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRunStream, type RunState, type NodeState } from '@/hooks/useRunStream'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PauseControls } from '@/components/run/PauseControls'
import { ContextInjectionPanel } from '@/components/run/ContextInjectionPanel'
import { DagView } from '@/components/run/DagView'
import { PermissionGuard } from '@/components/shared/PermissionGuard'
import { useT } from '@/lib/i18n/client'
import { AlertTriangle, CheckCircle2, XCircle, Loader2, ExternalLink, Star } from 'lucide-react'
import { RUN_STATUS_VARIANT } from '@/lib/utils/run-status'
import type { Permission } from '@/lib/auth/permissions'
import type { Dag } from '@/types/dag.types'
import type { RunStatus, NodeStatus } from '@/types/run.types'

// ─── Types ─────────────────────────────────────────────────────────────────

interface InitialRun {
  id: string
  status: string
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
}

interface Props {
  projectId: string
  initialRun: InitialRun
  initialNodes: InitialNode[]
  permissions: Set<Permission>
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
              className="focus:outline-none"
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
          <input
            type="number"
            min="0"
            step="0.5"
            value={hoursSaved}
            onChange={(e) => setHoursSaved(e.target.value)}
            placeholder="e.g. 2.5"
            className="w-32 rounded-md border border-surface-border bg-surface-1 px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500"
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
            placeholder="Any notes on business value or quality…"
            rows={2}
            className="w-full rounded-md border border-surface-border bg-surface-1 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
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

// ─── Status helpers ─────────────────────────────────────────────────────────

const STATUS_VARIANT = RUN_STATUS_VARIANT

const NODE_STATUS_ICON: Record<string, React.ReactNode> = {
  RUNNING: <Loader2 className="h-3.5 w-3.5 animate-spin text-status-running" />,
  COMPLETED: <CheckCircle2 className="h-3.5 w-3.5 text-status-completed" />,
  FAILED: <XCircle className="h-3.5 w-3.5 text-status-failed" />,
  ESCALATED: <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />,
}

// ─── Node card ──────────────────────────────────────────────────────────────

function NodeCard({ node }: { node: InitialNode | NodeState }) {
  const elapsed = node.started_at && !node.completed_at
    ? Math.round((Date.now() - new Date(node.started_at).getTime()) / 1000)
    : null

  return (
    <div className="flex items-start gap-3 rounded-lg border border-surface-border bg-surface-raised p-3 text-sm">
      <div className="mt-0.5 shrink-0">
        {NODE_STATUS_ICON[node.status] ?? <div className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-foreground">
            {node.agent_type}
            <span className="ml-1.5 text-xs text-muted-foreground font-mono">{node.node_id}</span>
          </span>
          <Badge variant={STATUS_VARIANT[node.status] ?? 'pending'} className="text-xs">
            {node.status}
          </Badge>
        </div>
        {elapsed !== null && (
          <p className="text-xs text-muted-foreground mt-0.5">{elapsed}s elapsed</p>
        )}
        {'error' in node && node.error && (
          <p className="text-xs text-red-400 mt-1 line-clamp-2">{node.error}</p>
        )}
        {'cost_usd' in node && node.cost_usd > 0 && (
          <p className="text-xs text-muted-foreground mt-0.5 font-mono">€{node.cost_usd.toFixed(4)}</p>
        )}
      </div>
    </div>
  )
}

// ─── Activity feed entry ────────────────────────────────────────────────────

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
  return (
    <PermissionGuard permissions={permissions} permission="runs:read_costs">
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Cost</span>
            <span className="font-mono font-medium text-foreground">€{costUsd.toFixed(4)}</span>
          </div>
          {budgetUsd && (
            <>
              <Progress value={Math.min(100, (costUsd / budgetUsd) * 100)} />
              <p className="text-xs text-muted-foreground text-right">
                Budget: €{budgetUsd.toFixed(2)}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </PermissionGuard>
  )
}

// ─── Main client component ──────────────────────────────────────────────────

export function RunDetailClient({ projectId, initialRun, initialNodes, permissions }: Props) {
  const stream = useRunStream(initialRun.id)

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
      <div className="flex items-start justify-between gap-4">
        <div>
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
        <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
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

          <Tabs defaultValue="agents">
            <TabsList>
              <TabsTrigger value="agents">Agents ({nodes.length})</TabsTrigger>
              <TabsTrigger value="dag">DAG</TabsTrigger>
              <TabsTrigger value="activity">Activity ({stream.events.length})</TabsTrigger>
              {initialRun.transparency_mode && (
                <TabsTrigger value="inject">Inject context</TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="agents">
              <div className="space-y-2">
                {nodes.length === 0 ? (
                  <Card>
                    <CardContent className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                      Waiting for agents to start…
                    </CardContent>
                  </Card>
                ) : (
                  nodes.map((node) => <NodeCard key={node.id} node={node} />)
                )}
              </div>
            </TabsContent>

            <TabsContent value="dag">
              <DagView
                dag={initialRun.dag}
                nodeStates={Object.fromEntries(
                  nodes.map(n => [n.node_id, {
                    status:   n.status,
                    cost_usd: ('cost_usd' in n ? n.cost_usd : undefined),
                    error:    ('error'    in n ? n.error    : undefined),
                  }]),
                )}
              />
            </TabsContent>

            <TabsContent value="activity">
              <Card>
                <CardContent className="p-4 space-y-2 max-h-80 overflow-y-auto">
                  {stream.events.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-4">No events yet.</p>
                  ) : (
                    stream.events
                      .map((ev, i) => ({ ev, i }))
                      .reverse()
                      .map(({ ev, i }) => {
                      const label =
                        ev.type === 'state_change'
                          ? `${ev.entity_type} ${ev.id?.slice(0, 6)} → ${ev.status}`
                          : ev.type === 'cost_update'
                          ? `Cost: €${ev.cost_usd.toFixed(4)}`
                          : ev.type === 'error'
                          ? `Error in ${ev.node_id}: ${ev.message}`
                          : ev.type === 'human_gate'
                          ? `Human gate: ${ev.reason}`
                          : ev.type === 'completed'
                          ? 'Run completed'
                          : ev.type
                      return <ActivityEntry key={`${ev.type}-${i}`} type={ev.type} label={label} />
                    })
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
          <CostMeter
            costUsd={run.cost_actual_usd}
            budgetUsd={initialRun.budget_usd}
            permissions={permissions}
          />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Run info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Tokens</span>
                <span className="font-mono">{run.tokens_actual.toLocaleString()}</span>
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
