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
      },
    }),
  ])

  if (!project || !run || run.project_id !== projectId) notFound()

  // Check permissions
  const instanceRole = (session.user as Record<string, unknown>).role as string | null ?? null
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())

  if (!permissions.has('gates:read')) {
    redirect(`/projects/${projectId}/runs/${runId}`)
  }

  const openGate = run.human_gates[0]

  // Serialize for client — reconstruct output shapes from individual Prisma fields
  const criticalReview = run.critical_reviews[0]
    ? {
        id: run.critical_reviews[0].id,
        node_id: 'n/a', // CriticalReviewResult has no node_id field in schema
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

  const evalResult = run.eval_results[0]
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
    <div className="space-y-6 animate-stagger">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
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
        gateId={openGate?.id ?? null}
        gateReason={openGate?.reason ?? null}
        criticalReview={criticalReview}
        evalResult={evalResult}
        permissions={permissions}
      />
    </div>
  )
}
