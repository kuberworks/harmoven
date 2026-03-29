'use client'

// app/(app)/projects/[projectId]/runs/[runId]/run-detail-client.tsx
// Live run view — SSE-powered, progressive disclosure levels.
// Receives initial state from Server Component, wires up useRunStream for updates.
// UX spec §3.5 — ExecutingView (Level 1–4), CompletedView, ProblemView.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRunStream, type RunState, type NodeState } from '@/hooks/useRunStream'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PauseControls } from '@/components/run/PauseControls'
import { ContextInjectionPanel } from '@/components/run/ContextInjectionPanel'
import { PermissionGuard } from '@/components/shared/PermissionGuard'
import { AlertTriangle, CheckCircle2, XCircle, Loader2, ExternalLink } from 'lucide-react'
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
              <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live
              </span>
            )}
            {stream.error && (
              <span className="text-xs text-amber-400">{stream.error}</span>
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
                      return <ActivityEntry key={i} type={ev.type} label={label} />
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
        </div>
      </div>
    </div>
  )
}
