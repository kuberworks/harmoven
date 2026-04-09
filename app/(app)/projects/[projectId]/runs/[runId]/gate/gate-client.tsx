'use client'

// app/(app)/projects/[projectId]/runs/[runId]/gate/gate-client.tsx
// Human Gate client — flat header matching mockup, tabs: Preview / Built / Critical / Eval / Cost.
// UX spec §3.6 — Human Gate.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
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
  plannerPlan: {
    task_summary: string | null
    confidence: number | null
    confidence_rationale: string | null
    assumptions: string[]
    nodes: Array<{ node_id: string; agent: string; description: string; complexity: string }>
  } | null
  reviewerEscalation: {
    findings: Array<{ issue?: string; recommendation?: string; severity?: string }>
    confidence: number | null
    node_id: string | null
  } | null
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
  imageArtifacts: Array<{ id: string; node_id: string | null; filename: string; mime_type: string }>
}

type Decision = 'approve' | 'abort' | 'modify'

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
  imageArtifacts,
  plannerPlan,
  reviewerEscalation,
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
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  // L-4 fix: track ignored/fixed findings locally so CriticalReviewTab stays reactive.
  const [ignoredFindings, setIgnoredFindings] = useState<Set<string>>(new Set())
  const [pendingFindings, setPendingFindings] = useState<Set<string>>(new Set())

  const hasOpenGate = !!gateId
  const canDecide = permissions.has('gates:write') && hasOpenGate
  const blockingCount = criticalReview?.output.findings.filter(f => f.severity === 'blocking').length ?? 0
  const totalFindings = criticalReview?.output.findings.length ?? 0

  const isPlannerExhausted = gateReason === 'planner_exhausted'

  // Human-readable gate reason labels
  const gateReasonLabel: Record<string, string> = {
    planner_exhausted:      'The AI planning agent could not build a valid execution plan after 3 attempts — your guidance is needed to continue',
    low_confidence_plan:    'Planner confidence below threshold — review the proposed plan before execution starts',
    low_confidence:         'Low confidence — human review requested',
    reviewer_escalation:    'Reviewer escalated — output requires a human decision',
    reviewer_findings:      'Reviewer found issues requiring a human decision',
    budget_warning:         'Budget threshold exceeded',
  }
  const gateReasonDisplay = gateReason ? (gateReasonLabel[gateReason] ?? gateReason) : null

  // Context-aware copy for the feedback panel
  const feedbackPanelLabel = isPlannerExhausted
    ? 'Provide guidance to help the planner generate a valid execution plan'
    : 'Request changes — describe what should be revised'
  const feedbackPlaceholder = isPlannerExhausted
    ? 'e.g. Limit to 5 parallel sections maximum. Focus only on the main topic — no appendices…'
    : 'e.g. The content is too long. Please shorten to 3 paragraphs and focus on the key points…'

  const defaultTab = writerContent || plannerPlan || reviewerEscalation
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

  async function submitDecision(decision: Decision, patch?: Record<string, unknown>) {
    setSubmitting(decision)
    setError(null)
    try {
      const body: Record<string, unknown> = { decision }
      if (patch) body['patch'] = patch
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
          {gateReasonDisplay && (
            <p className="text-sm text-muted-foreground mt-1">{gateReasonDisplay}</p>
          )}
        </div>

        {canDecide && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFeedback(v => !v)}
              disabled={!!submitting}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Request changes
            </Button>
            <PermissionGuard permissions={permissions} permission="gates:approve">
              <Button
                size="sm"
                onClick={() => handleDecision('approve')}
                disabled={!!submitting}
                title={isPlannerExhausted ? 'Re-run the planner with the same task description' : undefined}
                className="bg-emerald-600 hover:bg-emerald-500 text-white border-0"
              >
                {submitting === 'approve' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                {isPlannerExhausted ? 'Retry planning →' : 'Approve →'}
              </Button>
            </PermissionGuard>
          </div>
        )}
      </div>

      {/* ── Request changes feedback panel ── */}
      {showFeedback && canDecide && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
          <p className="text-sm font-medium text-amber-300">{feedbackPanelLabel}</p>
          <Textarea
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            placeholder={feedbackPlaceholder}
            className="min-h-[100px] border-amber-500/30 text-sm"
            disabled={!!submitting}
            autoFocus
          />
          <div className="flex items-center gap-2 justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setShowFeedback(false); setFeedbackText('') }}
              disabled={!!submitting}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => submitDecision('abort')}
              disabled={!!submitting}
              className="border-red-500/40 text-red-400 hover:bg-red-900/20"
            >
              {submitting === 'abort' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              Abort run
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (feedbackText.trim()) {
                  void submitDecision('modify', { review_feedback: feedbackText.trim() })
                }
              }}
              disabled={!!submitting || !feedbackText.trim()}
              className="bg-amber-600 hover:bg-amber-500 text-white border-0"
            >
              {submitting === 'modify' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
              Send feedback &amp; resume
            </Button>
          </div>
        </div>
      )}

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

        {/* Preview tab — writer output OR planner plan for low_confidence_plan */}
        <TabsContent value="preview" className="mt-0 pt-4">
          {writerContent ? (
            <div className="space-y-4 max-w-3xl">
              {/* Reviewer escalation findings banner — shown above writer output */}
              {reviewerEscalation && reviewerEscalation.findings.length > 0 && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                    <span className="text-sm font-semibold text-red-300">
                      Reviewer escalated — {reviewerEscalation.findings.length} issue{reviewerEscalation.findings.length > 1 ? 's' : ''} found
                    </span>
                    {reviewerEscalation.confidence !== null && (
                      <span className="ml-auto text-xs text-red-400/70 font-mono">confidence {reviewerEscalation.confidence}%</span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {reviewerEscalation.findings.map((f, i) => (
                      <div key={i} className="rounded-md border border-red-500/20 bg-surface-1 p-3">
                        <div className="flex items-start gap-2">
                          {f.severity && (
                            <span className={
                              'shrink-0 text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 mt-0.5 ' +
                              (f.severity === 'blocking' ? 'bg-red-500/20 text-red-400' :
                               f.severity === 'major'    ? 'bg-orange-500/20 text-orange-400' :
                               'bg-yellow-500/20 text-yellow-400')
                            }>{f.severity}</span>
                          )}
                          <div className="flex-1 min-w-0">
                            {f.issue && <p className="text-sm text-foreground leading-relaxed">{f.issue}</p>}
                            {f.recommendation && (
                              <p className="text-xs text-muted-foreground mt-1 italic">→ {f.recommendation}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded-lg border border-surface-border bg-surface-raised p-5">
                <div className="flex items-center gap-2 mb-4">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="text-sm font-semibold text-foreground">Content ready for review</span>
                  {writerType && (
                    <span className="text-xs text-muted-foreground/60 font-mono ml-auto">{writerType}</span>
                  )}
                </div>
                {/* Image artifacts (PYTHON_EXECUTOR output) take priority over raw source */}
                {writerType === 'python_code' && imageArtifacts.length > 0 ? (
                  <div className="space-y-4">
                    {imageArtifacts.map(a => (
                      <div key={a.id} className="rounded-md border border-surface-border/50 overflow-hidden bg-surface-1">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/runs/${runId}/artifacts/${a.id}/preview`}
                          alt={a.filename}
                          className="max-w-full h-auto block"
                          style={{ maxHeight: 520 }}
                        />
                        <p className="text-xs text-muted-foreground/60 font-mono px-3 py-1.5 border-t border-surface-border/40">{a.filename}</p>
                      </div>
                    ))}
                  </div>
                ) : writerType === 'python_code' ? (
                  <div className="p-4 bg-surface-1 rounded-md border border-surface-border/50">
                    <p className="text-xs text-muted-foreground/60 italic">Image generation in progress — no preview available yet.</p>
                  </div>
                ) : (
                  <div className="max-h-72 overflow-y-auto p-4 bg-surface-1 rounded-md border border-surface-border/50">
                    <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground leading-relaxed">
                      {writerContent}
                    </pre>
                  </div>
                )}
                {writerSummary && (
                  <p className="text-xs text-muted-foreground mt-3 italic">{writerSummary}</p>
                )}
              </div>
            </div>
          ) : plannerPlan ? (
            <div className="space-y-4 max-w-3xl">
              {/* Confidence banner */}
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                  <span className="text-sm font-semibold text-amber-300">
                    Planner confidence: {plannerPlan.confidence !== null ? `${plannerPlan.confidence}%` : '—'}
                  </span>
                </div>
                {plannerPlan.confidence_rationale && (
                  <p className="text-xs text-amber-400/80 mt-1">{plannerPlan.confidence_rationale}</p>
                )}
              </div>

              {/* Task summary */}
              {plannerPlan.task_summary && (
                <div className="rounded-lg border border-surface-border bg-surface-raised p-4">
                  <p className="text-xs text-muted-foreground/60 font-mono mb-1">Task summary</p>
                  <p className="text-sm text-foreground">{plannerPlan.task_summary}</p>
                </div>
              )}

              {/* Proposed plan nodes */}
              {plannerPlan.nodes.length > 0 && (
                <div className="rounded-lg border border-surface-border bg-surface-raised p-4 space-y-3">
                  <p className="text-xs text-muted-foreground/60 font-mono">Proposed execution plan ({plannerPlan.nodes.length} steps)</p>
                  <div className="space-y-2">
                    {plannerPlan.nodes.map((node, i) => (
                      <div
                        key={node.node_id}
                        className="flex items-start gap-3 rounded-md border border-surface-border/60 bg-surface-1 px-3 py-2.5"
                      >
                        <span className="shrink-0 mt-0.5 text-xs font-mono text-muted-foreground/50 w-6 text-right">{i + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono font-medium text-foreground">{node.node_id}</span>
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60 bg-surface-border/40 rounded px-1.5 py-0.5">
                              {node.agent}
                            </span>
                            <span className="text-[10px] text-muted-foreground/40 font-mono">{node.complexity}</span>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{node.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Assumptions */}
              {plannerPlan.assumptions.length > 0 && (
                <div className="rounded-lg border border-surface-border bg-surface-raised p-4">
                  <p className="text-xs text-muted-foreground/60 font-mono mb-2">Planner assumptions</p>
                  <ul className="space-y-1">
                    {plannerPlan.assumptions.map((a, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <span className="shrink-0 text-muted-foreground/40 mt-0.5">•</span>
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : isPlannerExhausted ? (
            <div className="space-y-4 max-w-3xl">
              {/* Failure summary */}
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-5">
                <div className="flex items-start gap-3 mb-3">
                  <XCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-red-300">Execution plan could not be generated</p>
                    <p className="text-xs text-red-400/70 mt-0.5">The planning agent failed after 3 consecutive attempts</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  This typically occurs when the task description is too broad, contains conflicting requirements, or requests a workflow that exceeds the planner&apos;s current capabilities.
                </p>
              </div>

              {/* Original task for reference */}
              {taskInput && (
                <div className="rounded-lg border border-surface-border bg-surface-raised p-4">
                  <p className="text-xs text-muted-foreground/60 font-mono mb-1.5">Original task</p>
                  <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{taskInput}</p>
                </div>
              )}

              {/* Actionable next steps */}
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <p className="text-xs text-muted-foreground/60 font-mono mb-3">How to proceed</p>
                <ul className="space-y-2.5 text-sm text-muted-foreground">
                  <li className="flex items-start gap-2.5">
                    <span className="shrink-0 text-amber-400 font-bold mt-0.5">1</span>
                    <span>
                      <span className="text-foreground font-medium">Request changes</span>
                      {' '}— clarify the task, break it into smaller steps, or remove conflicting requirements, then resume. The planner will retry with your guidance.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="shrink-0 text-muted-foreground/50 font-bold mt-0.5">2</span>
                    <span>
                      <span className="text-foreground font-medium">Retry planning</span>
                      {' '}— re-run the planner with the original task. Use this only if the failure may have been transient (e.g. provider timeout).
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="shrink-0 text-muted-foreground/50 font-bold mt-0.5">3</span>
                    <span>
                      <span className="text-foreground font-medium">Abort</span>
                      {' '}— cancel this run entirely.
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-surface-border bg-surface-raised p-10 max-w-3xl text-center">
              <MessageSquare className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No writer output available.</p>
              {gateReasonDisplay && (
                <p className="text-xs text-muted-foreground/60 mt-1">{gateReasonDisplay}</p>
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
                on_fix={(findingId) => setPendingFindings(prev => new Set(prev).add(findingId))}
                on_ignore={(findingId) => setIgnoredFindings(prev => new Set(prev).add(findingId))}
                on_show_all={() => { /* future: load suppressed findings */ }}
                on_increase={() => { /* future: rerun at higher severity */ }}
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
                    {n.tokens_in.toLocaleString('en')} / {n.tokens_out.toLocaleString('en')}
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
