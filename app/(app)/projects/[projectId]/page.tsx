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
import { Play, ChevronRight, Plus } from 'lucide-react'

interface Props {
  params: Promise<{ projectId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params
  const project = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
  return { title: project?.name ?? 'Project' }
}

const STATUS_VARIANT: Record<string, 'running' | 'completed' | 'failed' | 'paused' | 'pending' | 'suspended'> = {
  RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed',
  PAUSED: 'paused', PENDING: 'pending', SUSPENDED: 'suspended',
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

  const recentRuns = await db.run.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'desc' },
    take: 10,
    include: { user: { select: { name: true } } },
  })

  // Resolve permissions to gate tabs (returns empty set for non-members)
  const instanceRole = (session.user as Record<string, unknown>).role as string | null ?? null
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
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
            <Link href={`/projects/${projectId}/runs`}>
              <Plus className="h-4 w-4" />
              New run
            </Link>
          </Button>
        </PermissionGuard>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="runs">
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

        {/* Runs tab */}
        <TabsContent value="runs">
          {recentRuns.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Play className="h-8 w-8 text-muted-foreground/50" />
                <div>
                  <p className="font-medium text-foreground">No runs yet</p>
                  <p className="text-sm text-muted-foreground mt-1">Start your first run to see it here.</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col divide-y divide-surface-border rounded-card border border-surface-border overflow-hidden">
              {recentRuns.map((run) => (
                <Link
                  key={run.id}
                  href={`/projects/${projectId}/runs/${run.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 bg-surface-raised hover:bg-surface-hover transition-colors group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant={STATUS_VARIANT[run.status] ?? 'pending'}>
                      {run.status}
                    </Badge>
                    <span className="text-sm font-mono text-muted-foreground truncate">
                      {run.id.slice(0, 8)}
                    </span>
                    {run.user?.name && (
                      <span className="text-sm text-muted-foreground hidden sm:block">
                        by {run.user.name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {new Date(run.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
                  </div>
                </Link>
              ))}
            </div>
          )}
          <div className="mt-3 text-center">
            <Link
              href={`/projects/${projectId}/runs`}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              View all runs →
            </Link>
          </div>
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
