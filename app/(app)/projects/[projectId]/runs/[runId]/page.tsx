// app/(app)/projects/[projectId]/runs/[runId]/page.tsx
// Live run detail — DAG graph, node cards, cost meter, pause/inject controls.
// Server Component: fetches initial run data; delegates live view to client.
// UX spec §3.5 — Run execution, Level 2–4.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import { ChevronRight } from 'lucide-react'
import { RunDetailClient } from './run-detail-client'

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

  const [project, run, auditLogs] = await Promise.all([
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
            llm_profile_id: true, started_at: true, completed_at: true,
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
  ])

  if (!project || !run || run.project_id !== projectId) notFound()

  // Resolve permissions to pass to client (returns empty set for non-members)
  const instanceRole = (session.user as Record<string, unknown>).role as string | null ?? null
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())

  const serialisedRun = {
    id: run.id,
    status: run.status,
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
  }))

  return (
    <div className="space-y-6 animate-stagger">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground transition-colors">Projects</Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <Link href={`/projects/${projectId}`} className="hover:text-foreground transition-colors">
          {project.name}
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <Link href={`/projects/${projectId}/runs`} className="hover:text-foreground transition-colors">
          Runs
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-foreground font-mono font-medium">{runId.slice(0, 8)}</span>
      </nav>

      <RunDetailClient
        projectId={projectId}
        initialRun={serialisedRun}
        initialNodes={serialisedNodes}
        permissions={permissions}
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
