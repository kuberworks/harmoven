// app/(app)/projects/[projectId]/runs/[runId]/page.tsx
// Live run detail — DAG graph, node cards, cost meter, pause/inject controls.
// Server Component: fetches initial run data; delegates live view to client.
// UX spec §3.5 — Run execution, Level 2–4.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import { RunDetailClient } from './run-detail-client'
import { PageBreadcrumb } from '@/components/shared/PageBreadcrumb'
import { extractOutputSummary } from '@/lib/utils/run-output'

interface Props {
  params: Promise<{ projectId: string; runId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { runId } = await params
  return { title: `Run ${runId.slice(0, 8)}` }
}

export default async function RunPage({ params }: Props) {
  const { projectId, runId } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const [project, run, auditLogs, parentLinks, childLinks] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId, archived_at: null },
      select: { id: true, name: true },
    }),
    db.run.findUnique({
      where: { id: runId },
      include: {
        nodes: {
          orderBy: { node_id: 'asc' },
          select: {
            id: true, node_id: true, agent_type: true, status: true,
            llm_profile_id: true, started_at: true, completed_at: true, metadata: true,
            error: true, cost_usd: true, tokens_in: true, tokens_out: true,
            handoff_out: true, partial_output: true,
          },
        },
        human_gates: {
          where: { status: 'OPEN' },
          select: { id: true, reason: true },
          take: 1,
        },
      },
    }),
    db.auditLog.findMany({
      where: { run_id: runId },
      orderBy: { timestamp: 'asc' },
      select: { id: true, action_type: true, node_id: true, payload: true, timestamp: true },
      take: 200,
    }),
    db.runDependency.findMany({
      where: { child_run_id: runId },
      select: {
        parent_run: {
          select: {
            id:         true,
            status:     true,
            task_input: true,
            nodes: {
              where:   { agent_type: { in: ['REVIEWER', 'WRITER'] }, status: 'COMPLETED' },
              select:  { agent_type: true, node_id: true, handoff_out: true },
              orderBy: { node_id: 'asc' },
            },
          },
        },
      },
    }),
    db.runDependency.findMany({
      where: { parent_run_id: runId },
      select: { child_run: { select: { id: true, status: true, task_input: true } } },
    }),
  ])

  if (!project || !run || run.project_id !== projectId) notFound()

  // Resolve permissions to pass to client (returns empty set for non-members)
  const userRecord = session.user as Record<string, unknown>
  const instanceRole = userRecord.role as string | null ?? null
  const uiLevel = (userRecord.ui_level as string | undefined) === 'GUIDED' ? 'GUIDED'
    : (userRecord.ui_level as string | undefined) === 'ADVANCED' ? 'ADVANCED'
    : 'STANDARD'
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())

  const serialisedRun = {
    id: run.id,
    status: run.status,
    task_input: run.task_input as string | null,
    // Cost fields only exposed when caller has stream:costs
    cost_actual_usd: permissions.has('stream:costs') ? Number(run.cost_actual_usd) : 0,
    tokens_actual:   permissions.has('stream:costs') ? run.tokens_actual : 0,
    paused_at: run.paused_at?.toISOString() ?? null,
    started_at: run.started_at?.toISOString() ?? null,
    completed_at: run.completed_at?.toISOString() ?? null,
    transparency_mode: run.transparency_mode,
    dag: run.dag as unknown as import('@/types/dag.types').Dag,
    budget_usd: permissions.has('stream:costs') ? (run.budget_usd ? Number(run.budget_usd) : null) : null,
    openGate: run.human_gates[0]
      ? { id: run.human_gates[0].id, reason: run.human_gates[0].reason }
      : null,
  }

  const serialisedChain = {
    parents: parentLinks.map(l => {
      const pNodes = l.parent_run.nodes ?? []
      const reviewerNode = pNodes.find(n => n.agent_type === 'REVIEWER')
      const writerNode   = [...pNodes].reverse().find(n => n.agent_type === 'WRITER')
      const summary = extractOutputSummary(reviewerNode?.handoff_out) ??
                      extractOutputSummary(writerNode?.handoff_out)
      return {
        id:             l.parent_run.id,
        status:         l.parent_run.status as string,
        task_input:     typeof l.parent_run.task_input === 'string' ? l.parent_run.task_input.slice(0, 80) : null,
        output_summary: summary ?? null,
      }
    }),
    children: childLinks.map(l => ({
      id: l.child_run.id,
      status: l.child_run.status as string,
      task_input: typeof l.child_run.task_input === 'string' ? l.child_run.task_input.slice(0, 80) : null,
    })),
  }

  const serialisedNodes = run.nodes.map((n) => ({
    id: n.id,
    node_id: n.node_id,
    agent_type: n.agent_type,
    status: n.status,
    llm_profile_id: n.llm_profile_id,
    started_at: n.started_at?.toISOString() ?? null,
    completed_at: n.completed_at?.toISOString() ?? null,
    error: n.error ?? null,
    // Cost fields only exposed when caller has stream:costs
    cost_usd:   permissions.has('stream:costs') ? Number(n.cost_usd) : 0,
    tokens_in:  permissions.has('stream:costs') ? n.tokens_in : 0,
    tokens_out: permissions.has('stream:costs') ? n.tokens_out : 0,
    partial_output: n.partial_output ?? null,
    handoff_out: n.handoff_out ?? null,
    metadata: (n.metadata ?? {}) as Record<string, unknown>,
  }))

  return (
    <div className="space-y-6 animate-stagger">
      <PageBreadcrumb items={[
        { label: 'Projects', href: '/projects' },
        { label: project.name, href: `/projects/${projectId}` },
        { label: `Run ${runId.slice(0, 8)}` },
      ]} />

      <RunDetailClient
        projectId={projectId}
        initialRun={serialisedRun}
        initialNodes={serialisedNodes}
        permissions={permissions}
        uiLevel={uiLevel}
        chain={serialisedChain}
        initialEvents={auditLogs.map((log) => ({
          id: log.id,
          action_type: log.action_type,
          node_id: log.node_id ?? null,
          payload: log.payload as Record<string, unknown> | null,
          timestamp: log.timestamp.toISOString(),
        }))}
      />
    </div>
  )
}
