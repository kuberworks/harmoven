// app/(app)/projects/[projectId]/page.tsx
// Project overview — recent runs, member list, API keys, config history.
// Server Component: session + data fetched server-side.
// UX spec §3.7 — Project detail.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ApiKeyPanel } from '@/components/project/ApiKeyPanel'
import { RoleBuilder } from '@/components/project/RoleBuilder'
import ConfigHistory from '@/components/project/ConfigHistory'
import { PermissionGuard } from '@/components/shared/PermissionGuard'
import { RunsViewClient } from './runs-view-client'
import { ChevronRight, Plus } from 'lucide-react'
import { PageBreadcrumb } from '@/components/shared/PageBreadcrumb'

interface Props {
  params: Promise<{ projectId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params
  const project = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
  return { title: project?.name ?? 'Project' }
}

export default async function ProjectPage({ params }: Props) {
  const { projectId } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const project = await db.project.findUnique({
    where: { id: projectId, archived_at: null },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, email: true } } },
        take: 20,
      },
      _count: { select: { runs: true } },
    },
  })
  if (!project) notFound()

  // Resolve permissions to gate tabs (returns empty set for non-members)
  const instanceRole = (session.user as Record<string, unknown>).role as string | null ?? null
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())
  const showCosts = permissions.has('stream:costs')

  const rawRuns = await db.run.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'desc' },
    take: 30,
    select: {
      id: true,
      status: true,
      created_at: true,
      started_at: true,
      completed_at: true,
      paused_at: true,
      cost_actual_usd: true,
      tokens_actual: true,
      task_input: true,
      user: { select: { name: true } },
      human_gates: { where: { status: 'OPEN' }, select: { id: true }, take: 1 },
    },
  })

  const recentRuns = rawRuns.map((r) => ({
    id: r.id,
    status: r.status,
    created_at: r.created_at.toISOString(),
    started_at: r.started_at?.toISOString() ?? null,
    completed_at: r.completed_at?.toISOString() ?? null,
    paused_at: r.paused_at?.toISOString() ?? null,
    cost_actual_usd: showCosts ? Number(r.cost_actual_usd) : 0,
    tokens_actual: r.tokens_actual,
    task_input: typeof r.task_input === 'string' ? r.task_input : (r.task_input != null ? JSON.stringify(r.task_input) : null),
    user: r.user,
    has_open_gate: r.human_gates.length > 0,
  }))
  return (
    <div className="space-y-6 animate-stagger">
      <PageBreadcrumb items={[
        { label: 'Projects', href: '/projects' },
        { label: project.name },
      ]} />
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-1">
            <Link href="/projects" className="hover:text-foreground transition-colors">Projects</Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="text-foreground font-medium">{project.name}</span>
          </nav>
          <h1 className="text-xl font-semibold text-foreground">{project.name}</h1>
          {project.description && (
            <p className="text-sm text-muted-foreground mt-0.5">{project.description}</p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <Badge variant="secondary">{project.domain_profile}</Badge>
            <span className="text-xs text-muted-foreground">{project._count.runs} runs total</span>
          </div>
        </div>
        <PermissionGuard permissions={permissions} permission="runs:create">
          <Button asChild size="sm">
            <Link href={`/projects/${projectId}/runs/new`}>
              <Plus className="h-4 w-4" />
              New run
            </Link>
          </Button>
        </PermissionGuard>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="runs">
        <div className="overflow-x-auto">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <PermissionGuard permissions={permissions} permission="project:members">
            <TabsTrigger value="members">Members</TabsTrigger>
          </PermissionGuard>
          <PermissionGuard permissions={permissions} permission="project:credentials">
            <TabsTrigger value="api-keys">API Keys</TabsTrigger>
          </PermissionGuard>
          <PermissionGuard permissions={permissions} permission="project:edit">
            <TabsTrigger value="history">Config History</TabsTrigger>
          </PermissionGuard>
        </TabsList>
        </div>

        {/* Runs tab */}
        <TabsContent value="runs">
          <RunsViewClient projectId={projectId} runs={recentRuns} />
        </TabsContent>

        {/* Members tab */}
        <TabsContent value="members">
          <PermissionGuard permissions={permissions} permission="project:members">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Members</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {project.members.map((m) => (
                  <div key={m.user_id} className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">{m.user.name}</p>
                      <p className="text-xs text-muted-foreground">{m.user.email}</p>
                    </div>
                    <Badge variant="secondary">{m.role_id}</Badge>
                  </div>
                ))}
                {project.members.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">No members yet.</p>
                )}
              </CardContent>
            </Card>
            <div className="mt-4">
              <RoleBuilder projectId={projectId} />
            </div>
          </PermissionGuard>
        </TabsContent>

        {/* API Keys tab */}
        <TabsContent value="api-keys">
          <PermissionGuard permissions={permissions} permission="project:credentials">
            <ApiKeyPanel projectId={projectId} />
          </PermissionGuard>
        </TabsContent>

        {/* Config History tab */}
        <TabsContent value="history">
          <PermissionGuard permissions={permissions} permission="project:edit">
            <ConfigHistory projectId={projectId} />
          </PermissionGuard>
        </TabsContent>
      </Tabs>
    </div>
  )
}
