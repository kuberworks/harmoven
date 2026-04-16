// app/(app)/projects/[projectId]/members/page.tsx
// Project-level member management — list, invite, role assignment, removal.
// Server Component: fetches members and available roles.
// UX spec §3.7 — Project members.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import { getSessionLocale } from '@/lib/auth/session-helpers'
import { createT } from '@/lib/i18n/t'
import { ProjectMembersClient } from './members-client'

interface Props {
  params: Promise<{ projectId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params
  const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
  return { title: `Members — ${p?.name ?? 'Project'}` }
}

export default async function ProjectMembersPage({ params }: Props) {
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

  const canManage = permissions.has('project:members')
  const locale    = getSessionLocale(session.user as Record<string, unknown>)
  const t         = createT(locale)

  const [rawMembers, rawRoles] = await Promise.all([
    db.projectMember.findMany({
      where: { project_id: projectId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        role: { select: { id: true, name: true, display_name: true } },
      },
      orderBy: { added_at: 'asc' },
    }),
    db.projectRole.findMany({
      where: { OR: [{ project_id: projectId }, { project_id: null, is_builtin: true }] },
      orderBy: { is_builtin: 'asc' },
      select: { id: true, name: true, display_name: true },
    }),
  ])

  const members = rawMembers.map((m) => ({
    userId:      m.user.id,
    name:        m.user.name,
    email:       m.user.email,
    roleName:    m.role.name,
    roleDisplay: m.role.display_name,
    joinedAt:    m.added_at.toISOString(),
  }))

  const roles = rawRoles.map((r) => ({
    id:           r.id,
    name:         r.name,
    display_name: r.display_name,
  }))

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">{t('members.title')}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('members.subtitle', { name: project.name })}
        </p>
      </div>

      <ProjectMembersClient
        projectId={projectId}
        members={members}
        roles={roles}
        canManage={canManage}
        currentUserId={session.user.id}
      />
    </div>
  )
}
