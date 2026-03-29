// app/(app)/projects/[projectId]/runs/page.tsx
// Run list — Kanban columns by status + activity feed.
// Server Component for initial data; client component handles SSE updates.
// UX spec §3.3 — Kanban (project-scoped).

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { ChevronRight } from 'lucide-react'
import { RunsKanbanClient } from './runs-kanban-client'

interface Props {
  params: Promise<{ projectId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params
  const project = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
  return { title: project ? `Runs — ${project.name}` : 'Runs' }
}

export default async function RunsPage({ params }: Props) {
  const { projectId } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const project = await db.project.findUnique({
    where: { id: projectId, archived_at: null },
    select: { id: true, name: true },
  })
  if (!project) notFound()

  const runs = await db.run.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'desc' },
    take: 50,
    select: {
      id: true,
      status: true,
      created_at: true,
      started_at: true,
      completed_at: true,
      paused_at: true,
      cost_actual_usd: true,
      tokens_actual: true,
      user: { select: { name: true } },
    },
  })

  return (
    <div className="space-y-6 animate-stagger">
      {/* Breadcrumb */}
      <div>
        <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-1">
          <Link href="/projects" className="hover:text-foreground transition-colors">Projects</Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <Link href={`/projects/${projectId}`} className="hover:text-foreground transition-colors">
            {project.name}
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground font-medium">Runs</span>
        </nav>
        <h1 className="text-xl font-semibold text-foreground">Runs</h1>
        <p className="text-sm text-muted-foreground">{runs.length} total</p>
      </div>

      {/* Kanban — client for SSE updates */}
      <RunsKanbanClient
        projectId={projectId}
        initialRuns={runs.map((r) => ({
          ...r,
          created_at: r.created_at.toISOString(),
          started_at: r.started_at?.toISOString() ?? null,
          completed_at: r.completed_at?.toISOString() ?? null,
          paused_at: r.paused_at?.toISOString() ?? null,
          cost_actual_usd: Number(r.cost_actual_usd),
          user: r.user,
        }))}
      />
    </div>
  )
}
