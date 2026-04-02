// app/(app)/runs/page.tsx
// Global runs view — all runs across all projects the user has access to.
// Server Component: fetches runs, delegates status badge rendering to client.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { getInstanceRole } from '@/lib/auth/session-helpers'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Play } from 'lucide-react'
import { RUN_STATUS_VARIANT } from '@/lib/utils/run-status'

export const metadata: Metadata = { title: 'Runs' }

const STATUS_GROUPS = ['RUNNING', 'PAUSED', 'PENDING', 'COMPLETED', 'FAILED'] as const

export default async function RunsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = getInstanceRole(session.user as Record<string, unknown>)
  const isAdmin = instanceRole === 'instance_admin'

  // RBAC: admin sees all runs; others see only runs in their projects.
  const memberProjectIds: string[] | undefined = isAdmin
    ? undefined
    : (await db.projectMember.findMany({
        where: { user_id: session.user.id },
        select: { project_id: true },
      })).map(m => m.project_id)

  const projectIdFilter = memberProjectIds !== undefined
    ? { project_id: { in: memberProjectIds } }
    : {}

  const runs = await db.run.findMany({
    where: projectIdFilter,
    orderBy: { created_at: 'desc' },
    take: 100,
    select: {
      id: true,
      status: true,
      project_id: true,
      created_at: true,
      started_at: true,
      completed_at: true,
      cost_actual_usd: true,
      tokens_actual: true,
      project: { select: { name: true } },
      user: { select: { name: true } },
    },
  })

  const grouped = STATUS_GROUPS.map(status => ({
    status,
    runs: runs.filter(r => r.status === status),
  }))

  const activeCount = runs.filter(r => ['RUNNING', 'PAUSED', 'PENDING'].includes(r.status)).length

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground">Runs</h1>
        <p className="text-sm text-muted-foreground">
          {runs.length} total · {activeCount} active
        </p>
      </div>

      {/* Run list grouped by status */}
      {runs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Play className="h-8 w-8 text-muted-foreground opacity-40" />
            <p className="text-sm text-muted-foreground">No runs yet — start one from a project</p>
            <Link
              href="/projects"
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-hover transition-colors"
            >
              Browse projects
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {grouped.filter(g => g.runs.length > 0).map(({ status, runs: groupRuns }) => (
            <section key={status}>
              <h2 className="mb-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {status} ({groupRuns.length})
              </h2>
              <div className="space-y-2">
                {groupRuns.map(run => (
                  <Link
                    key={run.id}
                    href={`/projects/${run.project_id}/runs/${run.id}`}
                  >
                    <Card className="hover:bg-surface-hover transition-colors duration-150 cursor-pointer">
                      <CardContent className="flex items-center gap-4 py-3">
                        <Badge variant={RUN_STATUS_VARIANT[run.status] ?? 'pending'}>
                          {run.status}
                        </Badge>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate text-foreground">
                            {run.project?.name ?? '—'}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono truncate">
                            {run.id.slice(0, 8)}…
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-xs text-muted-foreground">
                            {run.started_at
                              ? new Date(run.started_at).toLocaleString('en', {
                                  dateStyle: 'short', timeStyle: 'short',
                                })
                              : new Date(run.created_at).toLocaleString('en', {
                                  dateStyle: 'short', timeStyle: 'short',
                                })}
                          </p>
                          {Number(run.cost_actual_usd) > 0 && (
                            <p className="text-xs font-mono text-muted-foreground">
                              €{Number(run.cost_actual_usd).toFixed(4)}
                            </p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
