// app/(app)/dashboard/page.tsx
// Dashboard — recent projects, admin stats, active runs.
// Server Component; data fetched from DB.
// Spec: FRONTEND-SDD-PROMPT.md Priority 2, UX.md §3.3.
//
// Section order (spec):
//   1. Recent projects       — all users
//   2. Instance stats        — admins only
//   3. Active runs           — filtered by membership for non-admins

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { getInstanceRole } from '@/lib/auth/session-helpers'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Play, FolderOpen, Plus, Users, FolderKanban, CheckCircle2, XCircle, Zap } from 'lucide-react'
import { redirect } from 'next/navigation'
import { RUN_STATUS_VARIANT } from '@/lib/utils/run-status'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = getInstanceRole(session.user as Record<string, unknown>)
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

  const startOfDay = new Date(new Date().setHours(0, 0, 0, 0))

  // Build query list — admin stats queries only run for admins.
  const baseQueries = [
    // Recent projects (ordered by last activity)
    db.project.findMany({
      where: memberProjectIds !== undefined ? { id: { in: memberProjectIds }, archived_at: null } : { archived_at: null },
      orderBy: { updated_at: 'desc' },
      take: 6,
      include: { _count: { select: { runs: true } } },
    }),
    // Active runs visible to this user
    db.run.findMany({
      where: { status: { in: ['RUNNING', 'PAUSED', 'PENDING'] }, ...projectIdFilter },
      orderBy: { started_at: 'desc' },
      take: 10,
      select: {
        id: true, project_id: true, status: true, started_at: true, task_input: true,
        project: { select: { name: true } },
      },
    }),
  ] as const

  const adminQueries = isAdmin
    ? [
        db.project.count({ where: { archived_at: null } }),
        db.user.count(),
        db.run.count({ where: { status: { in: ['RUNNING', 'PAUSED'] } } }),
        db.run.count({ where: { status: 'COMPLETED', completed_at: { gte: startOfDay } } }),
        db.run.count({ where: { status: 'FAILED', completed_at: { gte: startOfDay } } }),
      ] as const
    : []

  const [recentProjects, activeRuns, ...adminResults] = await Promise.all([
    ...baseQueries,
    ...adminQueries,
  ])

  const adminStats = isAdmin
    ? {
        totalProjects: adminResults[0] as number,
        totalUsers:    adminResults[1] as number,
        runningNow:    adminResults[2] as number,
        completedToday: adminResults[3] as number,
        failedToday:   adminResults[4] as number,
      }
    : null

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
        <Button asChild size="sm">
          <Link href={recentProjects.length > 0 ? `/projects/${recentProjects[0]!.id}/runs/new` : '/projects/new'}>
            <Plus className="h-4 w-4" />
            New run
          </Link>
        </Button>
      </div>

      {/* ── 1. Recent projects ─────────────────────────────────────── */}
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
                <Link href="/projects/new">Create a project</Link>
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

      {/* ── 2. Instance stats (admins only) ────────────────────────── */}
      {adminStats && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Instance overview
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard
              icon={<FolderKanban className="h-4 w-4" />}
              label="Projects"
              value={adminStats.totalProjects}
              href="/projects"
            />
            <StatCard
              icon={<Users className="h-4 w-4" />}
              label="Users"
              value={adminStats.totalUsers}
              href="/admin/users"
            />
            <StatCard
              icon={<Zap className="h-4 w-4 text-emerald-400" />}
              label="Running now"
              value={adminStats.runningNow}
              href="/runs"
              highlight={adminStats.runningNow > 0}
            />
            <StatCard
              icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
              label="Completed today"
              value={adminStats.completedToday}
              href="/analytics"
            />
            <StatCard
              icon={<XCircle className="h-4 w-4 text-red-400" />}
              label="Failed today"
              value={adminStats.failedToday}
              href="/analytics"
              danger={adminStats.failedToday > 0}
            />
          </div>
        </section>
      )}

      {/* ── 3. Active runs ─────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Active runs ({activeRuns.length})
        </h2>
        {activeRuns.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <Play className="h-8 w-8 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">No active runs right now</p>
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
                      <p className="text-xs text-muted-foreground truncate">
                        {run.task_input != null
                          ? (() => {
                              const ti = run.task_input
                              return (typeof ti === 'string' ? ti : JSON.stringify(ti)).slice(0, 80)
                            })()
                          : <span className="font-mono opacity-60">{run.id.slice(0, 8)}…</span>}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {run.started_at
                        ? new Date(run.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </span>
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

// ── Stat card (admin overview) ─────────────────────────────────────────────────

function StatCard({
  icon, label, value, href, highlight, danger,
}: {
  icon: React.ReactNode
  label: string
  value: number
  href: string
  highlight?: boolean
  danger?: boolean
}) {
  return (
    <Link href={href}>
      <Card className="hover:bg-surface-hover transition-colors duration-150 cursor-pointer">
        <CardContent className="flex flex-col gap-1.5 py-4 px-4">
          <div className={`flex items-center gap-1.5 text-xs font-medium ${danger ? 'text-red-400' : highlight ? 'text-emerald-400' : 'text-muted-foreground'}`}>
            {icon}
            {label}
          </div>
          <p className={`text-2xl font-semibold tabular-nums ${danger && value > 0 ? 'text-red-400' : 'text-foreground'}`}>
            {value.toLocaleString()}
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}
