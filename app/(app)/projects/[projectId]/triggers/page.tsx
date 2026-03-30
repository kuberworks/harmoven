// app/(app)/projects/[projectId]/triggers/page.tsx
// Cron + webhook trigger management for a project.
// Server Component: fetches triggers, resolves permissions.
// UX spec §3.7 — Project Triggers.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import { TriggersClient } from './triggers-client'

interface Props {
  params: Promise<{ projectId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params
  const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
  return { title: `Triggers — ${p?.name ?? 'Project'}` }
}

export default async function TriggersPage({ params }: Props) {
  const { projectId } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const project = await db.project.findUnique({
    where: { id: projectId, archived_at: null },
    select: { id: true, name: true },
  })
  if (!project) notFound()

  const instanceRole = (session.user as Record<string, unknown>).role as string | null ?? null
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())

  if (!permissions.has('project:read')) redirect('/projects')

  const canManage = permissions.has('admin:triggers') || instanceRole === 'instance_admin'

  const rawTriggers = await db.trigger.findMany({
    where: { project_id: projectId },
    orderBy: { created_at: 'desc' },
  })

  const triggers = rawTriggers.map((t) => ({
    id:          t.id,
    name:        t.name,
    type:        t.type,
    enabled:     t.enabled,
    config:      (t.config ?? {}) as Record<string, unknown>,
    lastFiredAt: t.last_fired_at?.toISOString() ?? null,
    runCount:    t.run_count,
    createdAt:   t.created_at.toISOString(),
  }))

  // Determine public webhook base URL — use NEXTAUTH_URL or APP_URL
  const webhookBase = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? ''

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Triggers</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Automatically start runs on a schedule or via webhook for{' '}
          <span className="text-foreground font-medium">{project.name}</span>.
        </p>
      </div>

      <TriggersClient
        projectId={projectId}
        triggers={triggers}
        canManage={canManage}
        webhookBase={webhookBase}
      />
    </div>
  )
}
