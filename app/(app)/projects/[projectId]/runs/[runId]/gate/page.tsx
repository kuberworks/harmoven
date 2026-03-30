// app/(app)/projects/[projectId]/runs/[runId]/gate/page.tsx
// Human Gate review — Critical findings, Eval scores, approve/modify/abort.
// Server Component: fetches gate + run data; passes to client.
// UX spec §3.6 — Human Gate.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import { ChevronRight } from 'lucide-react'
import { GateClient } from './gate-client'

interface Props {
  params: Promise<{ projectId: string; runId: string }>
}

export const metadata: Metadata = { title: 'Human Gate — Review' }

export default async function GatePage({ params }: Props) {
  const { projectId, runId } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const [project, run] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId, archived_at: null },
      select: { id: true, name: true },
    }),
    db.run.findUnique({
      where: { id: runId },
      include: {
        human_gates: {
          where: { status: 'OPEN' },
          orderBy: { opened_at: 'desc' },
          take: 1,
        },
        critical_reviews: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
        eval_results: {
          orderBy: { computed_at: 'desc' },
          take: 1,
        },
        nodes: {
          orderBy: { node_id: 'asc' },
          select: {
            node_id: true,
            agent_type: true,
            tokens_in: true,
            tokens_out: true,
            cost_usd: true,
            handoff_out: true,
            status: true,
          },
        },
      },
    }),
  ])

  if (!project || !run || run.project_id !== projectId) notFound()

  // Check permissions
  const userRecord = session.user as Record<string, unknown>
  const instanceRole = userRecord.role as string | null ?? null
  const uiLevel = (userRecord.ui_level as string | undefined) === 'GUIDED' ? 'GUIDED'
    : (userRecord.ui_level as string | undefined) === 'ADVANCED' ? 'ADVANCED'
    : 'STANDARD'
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())

  if (!permissions.has('gates:read')) {
    redirect(`/projects/${projectId}/runs/${runId}`)
  }

  const openGate = run.human_gates[0]

  // Extract writer output from the last WRITER node that has handoff_out
  const writerNode = [...run.nodes].reverse().find(n => n.agent_type === 'WRITER' && n.handoff_out != null)
  const writerHandoff = writerNode?.handoff_out as Record<string, unknown> | null ?? null
  const writerOutput = writerHandoff?.['output'] as Record<string, unknown> | undefined

  // ── Server-side data filtering by permission ──────────────────────────────
  // PermissionGuard in gate-client is UI-only. Sensitive data must be
  // withheld at this layer so it never reaches the rendered HTML payload.

  // Cost data — only included when caller has stream:costs
  const nodes = permissions.has('stream:costs')
    ? run.nodes.map(n => ({
        node_id: n.node_id,
        agent_type: n.agent_type,
        tokens_in: n.tokens_in,
        tokens_out: n.tokens_out,
        cost_usd: Number(n.cost_usd),
        status: n.status,
      }))
    : run.nodes.map(n => ({
        node_id: n.node_id,
        agent_type: n.agent_type,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        status: n.status,
      }))

  // Critical review — only included when caller has gates:read_critical
  const criticalReview = permissions.has('gates:read_critical') && run.critical_reviews[0]
    ? {
        id: run.critical_reviews[0].id,
        node_id: 'n/a',
        output: {
          verdict: run.critical_reviews[0].verdict as 'no_issues' | 'issues_found',
          severity: run.critical_reviews[0].severity as import('@/lib/agents/reviewer/critical-reviewer.types').CriticalSeverity,
          findings: run.critical_reviews[0].findings as unknown as import('@/lib/agents/reviewer/critical-reviewer.types').CriticalFinding[],
          suppressed: run.critical_reviews[0].suppressed,
          rationale: run.critical_reviews[0].rationale,
          meta: { llm_used: run.critical_reviews[0].llm_used, tokens_input: 0, tokens_output: 0, duration_seconds: 0, cost_usd: Number(run.critical_reviews[0].cost_usd) },
        } satisfies import('@/lib/agents/reviewer/critical-reviewer.types').CriticalReviewerOutput,
      }
    : null

  // Eval result — only included when caller has gates:read
  const evalResult = permissions.has('gates:read') && run.eval_results[0]
    ? {
        output: {
          run_id: runId,
          attempt: run.eval_results[0].attempt,
          overall_score: run.eval_results[0].overall_score,
          passed: run.eval_results[0].passed,
          verdict: (run.eval_results[0].passed ? 'PASS' : 'ESCALATE_HUMAN') as import('@/lib/agents/eval/eval.types').EvalVerdict,
          criteria: run.eval_results[0].criteria as unknown as import('@/lib/agents/eval/eval.types').ScoredCriterion[],
          feedback: run.eval_results[0].feedback,
          hard_fail_ids: [],
          meta: { llm_used: '', tokens_input: 0, tokens_output: 0, duration_seconds: 0 },
        } satisfies import('@/lib/agents/eval/eval.types').EvalAgentOutput,
        attempt: run.eval_results[0].attempt,
      }
    : null

  return (
    <div className="animate-stagger">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap mb-5">
        <Link href="/projects" className="hover:text-foreground transition-colors">Projects</Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <Link href={`/projects/${projectId}`} className="hover:text-foreground transition-colors">
          {project.name}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <Link href={`/projects/${projectId}/runs/${runId}`} className="hover:text-foreground transition-colors font-mono">
          {runId.slice(0, 8)}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground font-medium">Human Gate</span>
      </nav>

      <GateClient
        runId={runId}
        projectId={projectId}
        runStatus={run.status}
        taskInput={typeof run.task_input === 'string' ? run.task_input : JSON.stringify(run.task_input ?? '')}
        gateId={openGate?.id ?? null}
        gateReason={openGate?.reason ?? null}
        writerContent={(writerOutput?.['content'] ?? writerOutput?.['text'] ?? null) as string | null}
        writerSummary={(writerOutput?.['summary'] ?? null) as string | null}
        writerType={(writerOutput?.['type'] ?? null) as string | null}
        nodes={nodes}
        criticalReview={criticalReview}
        evalResult={evalResult}
        permissions={permissions}
        uiLevel={uiLevel}
      />
    </div>
  )
}
