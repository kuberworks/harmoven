// app/(app)/dashboard/page.tsx
// Dashboard — overview, recent projects, runs needing action, active runs.
// Server Component; data fetched from DB.
// Spec: FRONTEND-SDD-PROMPT.md Priority 2, UX.md §3.3.
//
// Section order:
//   1. Overview / stats          — adapts to user role + permissions
//   2. Needs your action         — PAUSED/SUSPENDED runs (only shown when non-empty)
//   3. Recent projects           — all users
//   4. Active runs               — RUNNING/PENDING, scoped to membership

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { getInstanceRole } from '@/lib/auth/session-helpers'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Play, FolderOpen, Plus, FolderKanban, CheckCircle2, XCircle, Zap, DollarSign, AlertCircle } from 'lucide-react'
import { redirect } from 'next/navigation'
import { RUN_STATUS_VARIANT } from '@/lib/utils/run-status'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = getInstanceRole(session.user as Record<string, unknown>)
  const isAdmin = instanceRole === 'instance_admin'
  // instance_admin has runs:read_costs globally — use that as the cost visibility gate.
  const canSeeCosts = isAdmin

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

  const runSelectFields = {
    id: true, project_id: true, status: true, started_at: true, task_input: true,
    project: { select: { name: true } },
  }

  // Base queries — run for every user.
  const baseQueries = [
    // Recent projects
    db.project.findMany({
      where: memberProjectIds !== undefined ? { id: { in: memberProjectIds }, archived_at: null } : { archived_at: null },
      orderBy: { updated_at: 'desc' },
      take: 6,
      include: { _count: { select: { runs: true } } },
    }),
    // Runs needing user action: PAUSED (human gate) + SUSPENDED
    db.run.findMany({
      where: { status: { in: ['PAUSED', 'SUSPENDED'] }, ...projectIdFilter },
      orderBy: { paused_at: 'desc' },
      take: 10,
      select: runSelectFields,
    }),
    // Active runs: RUNNING + PENDING
    db.run.findMany({
      where: { status: { in: ['RUNNING', 'PENDING'] }, ...projectIdFilter },
      orderBy: { started_at: 'desc' },
      take: 10,
      select: runSelectFields,
    }),
    // Completed today — scoped to membership
    db.run.count({ where: { status: 'COMPLETED', completed_at: { gte: startOfDay }, ...projectIdFilter } }),
    // Running now count for overview card
    db.run.count({ where: { status: { in: ['RUNNING', 'PENDING'] }, ...projectIdFilter } }),
  ] as const

  // Admin-only queries.
  const adminQueries = isAdmin
    ? [
        db.project.count({ where: { archived_at: null } }),
        db.run.count({ where: { status: 'FAILED', completed_at: { gte: startOfDay } } }),
      ] as const
    : []

  // Cost query — only if user can see costs.
  const costQuery = canSeeCosts
    ? db.run.aggregate({
        _sum: { cost_actual_usd: true },
        where: { completed_at: { gte: startOfDay } },
      })
    : null

  const [recentProjects, runsNeedingAction, activeRuns, completedToday, runningNow, ...rest] = await Promise.all([
    ...baseQueries,
    ...(adminQueries as unknown[]),
    ...(costQuery ? [costQuery] : []),
  ])

  // Unpack admin results (positions depend on whether costQuery is present).
  let totalProjects: number | undefined
  let failedToday: number | undefined
  let costTodayUsd: number | undefined

  if (isAdmin) {
    totalProjects = rest[0] as number
    failedToday   = rest[1] as number
    if (canSeeCosts) {
      const agg = rest[2] as Awaited<typeof costQuery>
      costTodayUsd = Number(agg?._sum?.cost_actual_usd ?? 0)
    }
  } else if (canSeeCosts) {
    const agg = rest[0] as Awaited<typeof costQuery>
    costTodayUsd = Number(agg?._sum?.cost_actual_usd ?? 0)
  }

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
        <Button asChild size="sm">
          <Link href={recentProjects.length > 0 ? `/projects/${(recentProjects as { id: string }[])[0]!.id}/runs/new` : '/projects/new'}>
            <Plus className="h-4 w-4" />
            New run
          </Link>
        </Button>
      </div>

      {/* ── 1. Overview ─────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Overview
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">

          {/* Everyone sees their own active + completed today */}
          <StatCard
            icon={<Zap className="h-4 w-4" />}
            label="Running now"
            value={(runningNow as number).toLocaleString('en')}
            href="/runs"
            highlight={(runningNow as number) > 0}
          />
          <StatCard
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Completed today"
            value={(completedToday as number).toLocaleString('en')}
            href="/runs"
          />

          {/* Cost today — only for users with cost visibility */}
          {canSeeCosts && (
            <StatCard
              icon={<DollarSign className="h-4 w-4" />}
              label="Cost today"
              value={`$${(costTodayUsd ?? 0).toFixed(2)}`}
              href="/analytics"
              highlight={(costTodayUsd ?? 0) > 0}
            />
          )}

          {/* Admin-only cards */}
          {isAdmin && (
            <>
              <StatCard
                icon={<FolderKanban className="h-4 w-4" />}
                label="Projects"
                value={(totalProjects ?? 0).toLocaleString('en')}
                href="/projects"
              />
              <StatCard
                icon={<XCircle className="h-4 w-4" />}
                label="Failed today"
                value={(failedToday ?? 0).toLocaleString('en')}
                href="/analytics"
                danger={(failedToday ?? 0) > 0}
              />
            </>
          )}
        </div>
      </section>

      {/* ── 2. Runs needing action ─────────────────────────────────── */}
      {(runsNeedingAction as unknown[]).length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Needs your action ({(runsNeedingAction as unknown[]).length})
            </h2>
            <Link href="/runs?status=PAUSED" className="text-xs text-[var(--accent-amber-9)] hover:underline">
              All →
            </Link>
          </div>
          <div className="space-y-2">
            {(runsNeedingAction as RunRow[]).map(run => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        </section>
      )}

      {/* ── 3. Recent projects ──────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Recent projects
          </h2>
          <Link href="/projects" className="text-xs text-[var(--accent-amber-9)] hover:underline">
            All projects →
          </Link>
        </div>

        {(recentProjects as unknown[]).length === 0 ? (
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
            {(recentProjects as { id: string; name: string; _count: { runs: number } }[]).map(project => (
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

      {/* ── 4. Active runs ─────────────────────────────────────────── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Active runs {(activeRuns as unknown[]).length > 0 && `(${(activeRuns as unknown[]).length})`}
          </h2>
          <Link href="/runs?status=RUNNING" className="text-xs text-[var(--accent-amber-9)] hover:underline">
            All →
          </Link>
        </div>
        {(activeRuns as unknown[]).length === 0 ? (
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
            {(activeRuns as RunRow[]).map(run => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Shared run row type ────────────────────────────────────────────────────────

type RunRow = {
  id: string
  project_id: string
  status: string
  started_at: Date | null
  task_input: unknown
  project: { name: string } | null
}

// ── Run card ──────────────────────────────────────────────────────────────────

function RunCard({ run }: { run: RunRow }) {
  return (
    <Link href={`/projects/${run.project_id}/runs/${run.id}`}>
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
              ? new Date(run.started_at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
              : '—'}
          </span>
        </CardContent>
      </Card>
    </Link>
  )
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({
  icon, label, value, href, highlight, danger,
}: {
  icon: React.ReactNode
  label: string
  value: string
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
          <p className={`text-2xl font-semibold tabular-nums ${danger && value !== '0' ? 'text-red-400' : 'text-foreground'}`}>
            {value}
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}
