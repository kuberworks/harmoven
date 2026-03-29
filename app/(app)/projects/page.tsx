// app/(app)/projects/page.tsx
// Project list — shows all projects the user can see.
// Server Component; data fetched from DB.
// UX spec §3.7 — Project detail.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { FolderOpen, Plus, Play } from 'lucide-react'

export const metadata: Metadata = { title: 'Projects' }

export default async function ProjectsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const userId      = session.user.id
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin     = instanceRole === 'instance_admin'

  // Security: non-admin users see only projects they are members of.
  // instance_admin sees all (no membership filter applied).
  // Two-query pattern avoids a cross-join; ProjectMember.user_id is indexed.
  const memberProjectIds = isAdmin
    ? undefined
    : (
        await db.projectMember.findMany({
          where: { user_id: userId },
          select: { project_id: true },
        })
      ).map((m) => m.project_id)

  const projects = await db.project.findMany({
    where: {
      archived_at: null,
      ...(memberProjectIds !== undefined ? { id: { in: memberProjectIds } } : {}),
    },
    orderBy: { updated_at: 'desc' },
    include: {
      _count: { select: { runs: true } },
      runs: {
        where: { status: { in: ['RUNNING', 'PAUSED', 'PENDING'] } },
        select: { id: true, status: true },
        take: 10,
      },
    },
  })

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground">
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/projects/new">
            <Plus className="h-4 w-4" />
            New project
          </Link>
        </Button>
      </div>

      {/* Grid */}
      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
            <div>
              <p className="font-medium text-foreground">No projects yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create your first project to start running agents.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/projects/new">
                <Plus className="h-4 w-4" />
                New project
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const activeCount = project.runs.length
            return (
              <Link key={project.id} href={`/projects/${project.id}`} className="group outline-none">
                <Card className="h-full transition-colors group-hover:border-accent-amber group-focus-visible:ring-2 group-focus-visible:ring-amber-500">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-base font-semibold leading-tight line-clamp-2">
                        {project.name}
                      </CardTitle>
                      {activeCount > 0 && (
                        <Badge variant="running" className="shrink-0">
                          <Play className="h-2.5 w-2.5" />
                          {activeCount} active
                        </Badge>
                      )}
                    </div>
                    {project.domain_profile && (
                      <Badge variant="secondary" className="w-fit text-xs">
                        {project.domain_profile}
                      </Badge>
                    )}
                  </CardHeader>
                  <CardContent className="pt-0">
                    {project.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                        {project.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{project._count.runs} run{project._count.runs !== 1 ? 's' : ''}</span>
                      <span>
                        {new Date(project.updated_at).toLocaleDateString('en', {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
