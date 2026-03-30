// app/(app)/projects/[projectId]/settings/history/page.tsx
// Config history — immutable timeline with diff view (Amendment 83).
// Server Component shell; ConfigHistory component handles diff display.
// UX spec §3.7 — Config History.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import ConfigHistory from '@/components/project/ConfigHistory'
import { ChevronRight } from 'lucide-react'

interface Props {
  params: Promise<{ projectId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params
  const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
  return { title: `Config History — ${p?.name ?? 'Project'}` }
}

export default async function ConfigHistoryPage({ params }: Props) {
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

  const canRestore = permissions.has('project:edit')

  return (
    <div className="max-w-4xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-muted-foreground mb-4">
        <Link href={`/projects/${projectId}/settings`} className="hover:text-foreground transition-colors">
          Settings
        </Link>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        <span className="text-foreground">Config history</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">Config history</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Immutable record of all configuration changes for {project.name}.
        </p>
      </div>

      {/* ConfigHistory component handles fetching + diff rendering */}
      <ConfigHistory projectId={projectId} />
    </div>
  )
}
