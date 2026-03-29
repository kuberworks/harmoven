'use client'

// app/(app)/projects/[projectId]/runs/[runId]/gate/gate-client.tsx
// Human Gate client — tabs: Critical findings, Eval score, + approve/abort.
// UX spec §3.6 — Human Gate: Reviewer tab, Critical tab, Eval tab.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PermissionGuard } from '@/components/shared/PermissionGuard'
import { CriticalReviewTab } from '@/components/gate/CriticalReviewTab'
import { EvalTab } from '@/components/gate/EvalTab'
import type { CriticalReviewerOutput } from '@/lib/agents/reviewer/critical-reviewer.types'
import type { EvalAgentOutput } from '@/lib/agents/eval/eval.types'
import type { Permission } from '@/lib/auth/permissions'
import { CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react'

interface Props {
  runId: string
  projectId: string
  runStatus: string
  gateId: string | null
  gateReason: string | null
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
}

type Decision = 'approve' | 'abort'

export function GateClient({
  runId,
  projectId,
  runStatus,
  gateId,
  gateReason,
  criticalReview,
  evalResult,
  permissions,
}: Props) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState<Decision | null>(null)
  const [error, setError] = useState<string | null>(null)

  const hasOpenGate = !!gateId
  const canDecide = permissions.has('gates:write') && hasOpenGate

  async function handleDecision(decision: Decision) {
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
      // Navigate back to run view
      router.push(`/projects/${projectId}/runs/${runId}`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Gate status banner */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5 mb-1">
                {hasOpenGate ? (
                  <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                )}
                <h1 className="text-lg font-semibold text-foreground">
                  {hasOpenGate ? 'Awaiting your review' : 'Gate resolved'}
                </h1>
              </div>
              {gateReason && (
                <p className="text-sm text-muted-foreground">{gateReason}</p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Badge variant={runStatus === 'SUSPENDED' ? 'suspended' : 'paused'}>
                  Run {runStatus}
                </Badge>
                <span className="text-xs text-muted-foreground font-mono">{runId.slice(0, 8)}</span>
              </div>
            </div>

            {/* Actions */}
            {canDecide && (
              <div className="flex items-center gap-2 shrink-0">
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
                    Approve
                  </Button>
                </PermissionGuard>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleDecision('abort')}
                  disabled={!!submitting}
                >
                  {submitting === 'abort' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5" />
                  )}
                  Abort
                </Button>
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>
          )}
        </CardContent>
      </Card>

      {/* Review tabs */}
      <Tabs defaultValue={criticalReview ? 'critical' : evalResult ? 'eval' : 'summary'}>
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          {criticalReview && (
            <PermissionGuard permissions={permissions} permission="gates:read_critical">
              <TabsTrigger value="critical">Critical findings</TabsTrigger>
            </PermissionGuard>
          )}
          {evalResult && (
            <PermissionGuard permissions={permissions} permission="gates:read">
              <TabsTrigger value="eval">Eval score</TabsTrigger>
            </PermissionGuard>
          )}
        </TabsList>

        {/* Summary tab */}
        <TabsContent value="summary">
          <Card>
            <CardContent className="p-5 space-y-3">
              <h2 className="text-sm font-medium text-foreground">What needs reviewing</h2>
              {gateReason ? (
                <p className="text-sm text-muted-foreground">{gateReason}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The agent execution was paused for human review before continuing.
                  Check the Critical findings and Eval tabs for details.
                </p>
              )}
              <div className="grid grid-cols-2 gap-3 pt-2 text-sm">
                {criticalReview && (
                  <div className="rounded-lg border border-surface-border bg-surface-raised p-3">
                    <p className="text-xs text-muted-foreground mb-1">Critical findings</p>
                    <p className="font-semibold text-foreground">
                      {criticalReview.output.findings.length} issue{criticalReview.output.findings.length !== 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">in node {criticalReview.node_id}</p>
                  </div>
                )}
                {evalResult && (
                  <div className="rounded-lg border border-surface-border bg-surface-raised p-3">
                    <p className="text-xs text-muted-foreground mb-1">Eval score</p>
                    <p className="font-semibold text-foreground">
                      {Math.round(evalResult.output.overall_score * 100)}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {evalResult.output.verdict}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Critical tab */}
        {criticalReview && (
          <TabsContent value="critical">
            <PermissionGuard permissions={permissions} permission="gates:read_critical">
              <CriticalReviewTab
                output={criticalReview.output}
                run_id={runId}
                node_id={criticalReview.node_id}
                result_id={criticalReview.id}
                ui_level="STANDARD"
                on_fix={(findingId) => console.log('fix', findingId)}
                on_ignore={(findingId) => console.log('ignore', findingId)}
                on_show_all={() => console.log('show all')}
                on_increase={() => console.log('increase severity')}
              />
            </PermissionGuard>
          </TabsContent>
        )}

        {/* Eval tab */}
        {evalResult && (
          <TabsContent value="eval">
            <PermissionGuard permissions={permissions} permission="gates:read">
              <EvalTab evalOutput={evalResult.output} totalAttempts={evalResult.attempt} />
            </PermissionGuard>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
