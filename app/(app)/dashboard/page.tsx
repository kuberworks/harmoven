// app/(app)/dashboard/page.tsx
// Dashboard — active runs summary + recent projects.
// Server Component; data fetched from DB.
// Spec: FRONTEND-SDD-PROMPT.md Priority 2, UX.md §3.3.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Play, FolderOpen, Plus } from 'lucide-react'
import { redirect } from 'next/navigation'
import { RUN_STATUS_VARIANT } from '@/lib/utils/run-status'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = ((session.user as Record<string, unknown>).role as string | undefined) ?? 'user'
  const isAdmin = instanceRole === 'instance_admin'

  // RBAC: instance_admin sees all projects/runs; other users see only their memberships.
  const memberProjectIds: string[] | undefined = isAdmin
    ? undefined
    : (await db.projectMember.findMany({
        where: { user_id: session.user.id },
        select: { project_id: true },
      })).map(m => m.project_id)

  const projectIdFilter = memberProjectIds !== undefined
    ? { project_id: { in: memberProjectIds } }
    : {}

  // Fetch active runs the user can see (last 10 across accessible projects)
  const activeRuns = await db.run.findMany({
    where: {
      status: { in: ['RUNNING', 'PAUSED', 'PENDING'] },
      ...projectIdFilter,
    },
    orderBy: { started_at: 'desc' },
    take: 10,
    include: { project: { select: { name: true } } },
  })

  // Recent projects scoped to user membership
  const recentProjects = await db.project.findMany({
    where: memberProjectIds !== undefined
      ? { id: { in: memberProjectIds } }
      : {},
    orderBy: { updated_at: 'desc' },
    take: 6,
    include: { _count: { select: { runs: true } } },
  })

  const completedToday = await db.run.count({
    where: {
      status: 'COMPLETED',
      completed_at: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      ...projectIdFilter,
    },
  })

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {completedToday} run{completedToday !== 1 ? 's' : ''} completed today
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/projects"><Plus className="h-4 w-4" /> New run</Link>
        </Button>
      </div>

      {/* Active runs */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Active runs ({activeRuns.length})
        </h2>
        {activeRuns.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <Play className="h-8 w-8 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">No active runs — start one from a project</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/projects">Browse projects</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {activeRuns.map(run => (
              <Link key={run.id} href={`/projects/${run.project_id}/runs/${run.id}`}>
                <Card className="hover:bg-surface-hover transition-colors duration-150 cursor-pointer">
                  <CardContent className="flex items-center gap-4 py-3">
                    <Badge variant={RUN_STATUS_VARIANT[run.status] ?? 'pending'}>
                      {run.status}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate text-foreground">
                        {run.project?.name ?? 'Unknown project'}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {run.id.slice(0, 8)}…
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {run.started_at ? new Date(run.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                    </span>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent projects */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Recent projects
          </h2>
          <Link href="/projects" className="text-xs text-[var(--accent-amber-9)] hover:underline">
            All projects →
          </Link>
        </div>

        {recentProjects.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">No projects yet</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/projects">Create a project</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recentProjects.map(project => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <Card className="hover:bg-surface-hover transition-colors duration-150 cursor-pointer h-full">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm truncate">{project.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground">
                      {project._count.runs} run{project._count.runs !== 1 ? 's' : ''}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
