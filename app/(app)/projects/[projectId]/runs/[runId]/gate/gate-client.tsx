'use client'

// app/(app)/projects/[projectId]/runs/[runId]/gate/gate-client.tsx
// Human Gate client — flat header matching mockup, tabs: Preview / Built / Critical / Eval / Cost.
// UX spec §3.6 — Human Gate.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PermissionGuard } from '@/components/shared/PermissionGuard'
import { CriticalReviewTab } from '@/components/gate/CriticalReviewTab'
import { EvalTab } from '@/components/gate/EvalTab'
import type { CriticalReviewerOutput } from '@/lib/agents/reviewer/critical-reviewer.types'
import type { EvalAgentOutput } from '@/lib/agents/eval/eval.types'
import type { Permission } from '@/lib/auth/permissions'
import { CheckCircle2, XCircle, AlertTriangle, Loader2, MessageSquare } from 'lucide-react'

interface NodeCost {
  node_id: string
  agent_type: string
  tokens_in: number
  tokens_out: number
  cost_usd: number
  status: string
}

interface Props {
  runId: string
  projectId: string
  runStatus: string
  taskInput: string
  gateId: string | null
  gateReason: string | null
  writerContent: string | null
  writerSummary: string | null
  writerType: string | null
  nodes: NodeCost[]
  criticalReview: {
    id: string
    node_id: string
    output: CriticalReviewerOutput
  } | null
  evalResult: {
    output: EvalAgentOutput
    attempt: number
  } | null
  permissions: Set<Permission>
  uiLevel: 'GUIDED' | 'STANDARD' | 'ADVANCED'
}

type Decision = 'approve' | 'abort'

export function GateClient({
  runId,
  projectId,
  runStatus,
  taskInput,
  gateId,
  gateReason,
  writerContent,
  writerSummary,
  writerType,
  nodes,
  criticalReview,
  evalResult,
  permissions,
  uiLevel,
}: Props) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blockingWarn, setBlockingWarn] = useState(false)

  const hasOpenGate = !!gateId
  const canDecide = permissions.has('gates:write') && hasOpenGate
  const blockingCount = criticalReview?.output.findings.filter(f => f.severity === 'blocking').length ?? 0
  const totalFindings = criticalReview?.output.findings.length ?? 0

  const defaultTab = writerContent
    ? 'preview'
    : criticalReview
      ? 'critical'
      : evalResult
        ? 'eval'
        : 'preview'

  const totalCost = nodes.reduce((s, n) => s + n.cost_usd, 0)

  async function handleDecision(decision: Decision) {
    if (decision === 'approve' && blockingCount > 0) {
      setBlockingWarn(true)
      return
    }
    await submitDecision(decision)
  }

  async function submitDecision(decision: Decision) {
    setSubmitting(decision)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      router.push(`/projects/${projectId}/runs/${runId}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div>
      {/* ── Page header — matches mockup .ph ── */}
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <p className="text-xs text-muted-foreground/60 mb-1 font-mono">{runId.slice(0, 8)}</p>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-semibold text-foreground truncate max-w-[500px]">
              {taskInput || 'Review needed'}
            </h1>
            <Badge variant={hasOpenGate ? 'suspended' : 'completed'} className="shrink-0">
              {hasOpenGate ? '⏸ Decision' : runStatus === 'COMPLETED' ? '✓ Resolved' : runStatus}
            </Badge>
          </div>
          {gateReason && (
            <p className="text-sm text-muted-foreground mt-1">{gateReason}</p>
          )}
        </div>

        {canDecide && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleDecision('abort')}
              disabled={!!submitting}
            >
              {submitting === 'abort' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              Request changes
            </Button>
            <PermissionGuard permissions={permissions} permission="gates:approve">
              <Button
                size="sm"
                onClick={() => handleDecision('approve')}
                disabled={!!submitting}
                className="bg-emerald-600 hover:bg-emerald-500 text-white border-0"
              >
                {submitting === 'approve' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Approve →
              </Button>
            </PermissionGuard>
          </div>
        )}
      </div>

      {/* ── Blocking warning banner ── */}
      {blockingWarn && (
        <div className="flex items-center gap-3 mb-4 px-4 py-3 rounded-lg bg-red-950/40 border border-red-500/30 text-sm text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
          <span className="flex-1">
            ⚠ {blockingCount} blocking issue{blockingCount > 1 ? 's' : ''} found. Review the Critical tab before approving.
          </span>
          <PermissionGuard permissions={permissions} permission="gates:approve">
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/40 text-red-300 hover:bg-red-900/30 shrink-0"
              onClick={async () => {
                setBlockingWarn(false)
                await submitDecision('approve')
              }}
              disabled={!!submitting}
            >
              Approve anyway
            </Button>
          </PermissionGuard>
        </div>
      )}

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-400">{error}</p>
      )}

      {/* ── Tabs ── */}
      <Tabs defaultValue={defaultTab}>
        <TabsList className="mb-0">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="built">Built</TabsTrigger>
          {evalResult && (
            <PermissionGuard permissions={permissions} permission="gates:read">
              <TabsTrigger value="eval">Eval ⚗</TabsTrigger>
            </PermissionGuard>
          )}
          {criticalReview && (
            <PermissionGuard permissions={permissions} permission="gates:read_critical">
              <TabsTrigger value="critical" className="flex items-center gap-1.5">
                Critical
                {totalFindings > 0 && (
                  <span className="bg-red-500/20 text-red-400 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold">
                    {totalFindings}
                  </span>
                )}
              </TabsTrigger>
            </PermissionGuard>
          )}
          <PermissionGuard permissions={permissions} permission="stream:costs">
            <TabsTrigger value="cost">Cost</TabsTrigger>
          </PermissionGuard>
        </TabsList>

        {/* Preview tab — actual writer output */}
        <TabsContent value="preview" className="mt-0 pt-4">
          {writerContent ? (
            <div className="rounded-lg border border-surface-border bg-surface-raised p-5 max-w-3xl">
              <div className="flex items-center gap-2 mb-4">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <span className="text-sm font-semibold text-foreground">Content ready for review</span>
                {writerType && (
                  <span className="text-xs text-muted-foreground/60 font-mono ml-auto">{writerType}</span>
                )}
              </div>
              <div className="max-h-72 overflow-y-auto p-4 bg-surface-1 rounded-md border border-surface-border/50">
                <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground leading-relaxed">
                  {writerContent}
                </pre>
              </div>
              {writerSummary && (
                <p className="text-xs text-muted-foreground mt-3 italic">{writerSummary}</p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-surface-border bg-surface-raised p-10 max-w-3xl text-center">
              <MessageSquare className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No writer output available.</p>
              {gateReason && (
                <p className="text-xs text-muted-foreground/60 mt-1">{gateReason}</p>
              )}
            </div>
          )}
        </TabsContent>

        {/* Built tab — textual summary / what was produced */}
        <TabsContent value="built" className="mt-0 pt-4">
          <div className="rounded-lg border border-surface-border bg-surface-raised p-5 max-w-2xl space-y-4">
            <div className="text-sm text-muted-foreground leading-relaxed">
              {writerSummary ? (
                <p>{writerSummary}</p>
              ) : writerContent ? (
                <p>{writerContent.slice(0, 500)}{writerContent.length > 500 ? '…' : ''}</p>
              ) : (
                <p className="text-muted-foreground/60 italic">No summary available.</p>
              )}
              {writerType && (
                <p className="text-xs text-muted-foreground/50 font-mono mt-2">type: {writerType}</p>
              )}
            </div>
            {nodes.length > 0 && (
              <div className="pt-3 border-t border-surface-border/50">
                <p className="text-xs text-muted-foreground/60 mb-2">Pipeline executed</p>
                <div className="flex flex-wrap gap-2">
                  {nodes.map(n => (
                    <span
                      key={n.node_id}
                      className="text-xs font-mono px-2 py-1 rounded bg-surface-1 border border-surface-border text-muted-foreground"
                    >
                      {n.node_id} · {n.agent_type}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Eval tab */}
        {evalResult && (
          <TabsContent value="eval" className="mt-0 pt-4">
            <PermissionGuard permissions={permissions} permission="gates:read">
              <EvalTab evalOutput={evalResult.output} totalAttempts={evalResult.attempt} />
            </PermissionGuard>
          </TabsContent>
        )}

        {/* Critical tab */}
        {criticalReview && (
          <TabsContent value="critical" className="mt-0 pt-4">
            <PermissionGuard permissions={permissions} permission="gates:read_critical">
              <CriticalReviewTab
                output={criticalReview.output}
                run_id={runId}
                node_id={criticalReview.node_id}
                result_id={criticalReview.id}
                ui_level={uiLevel}
                on_fix={(findingId) => console.log('fix', findingId)}
                on_ignore={(findingId) => console.log('ignore', findingId)}
                on_show_all={() => console.log('show all')}
                on_increase={() => console.log('increase severity')}
              />
            </PermissionGuard>
          </TabsContent>
        )}

        {/* Cost tab */}
        <TabsContent value="cost" className="mt-0 pt-4">
          <PermissionGuard permissions={permissions} permission="stream:costs">
            <div className="max-w-lg rounded-lg border border-surface-border bg-surface-raised overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-2 text-xs text-muted-foreground/60 border-b border-surface-border bg-surface-1 font-medium uppercase tracking-wide">
                <span>Agent</span>
                <span className="text-right">Tokens in / out</span>
                <span className="text-right w-20">Cost</span>
              </div>
              {nodes.map(n => (
                <div
                  key={n.node_id}
                  className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-2.5 text-sm border-b border-surface-border/40 last:border-0"
                >
                  <span className="text-foreground font-medium">
                    {n.agent_type}
                    <span className="text-xs text-muted-foreground/50 font-mono ml-2">{n.node_id}</span>
                  </span>
                  <span className="text-xs text-muted-foreground font-mono text-right">
                    {n.tokens_in.toLocaleString()} / {n.tokens_out.toLocaleString()}
                  </span>
                  <span className="text-xs font-mono text-right w-20 text-muted-foreground">
                    {n.cost_usd > 0 ? `€${n.cost_usd.toFixed(4)}` : '—'}
                  </span>
                </div>
              ))}
              <div className="flex justify-between items-center px-4 py-2.5 border-t border-surface-border bg-surface-1">
                <span className="text-sm font-semibold text-foreground">Total</span>
                <span className="text-sm font-bold text-foreground font-mono">€{totalCost.toFixed(4)}</span>
              </div>
            </div>
          </PermissionGuard>
        </TabsContent>
      </Tabs>
    </div>
  )
}
