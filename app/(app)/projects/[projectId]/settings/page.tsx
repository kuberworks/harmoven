// app/(app)/projects/[projectId]/settings/page.tsx
// Project settings — domain, confidentiality, AGENTS.md, transparency mode.
// Server Component: fetches project, resolves permissions.
// UX spec §3.7 — Project settings.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { resolvePermissions } from '@/lib/auth/rbac'
import { getSessionLocale } from '@/lib/auth/session-helpers'
import { createT } from '@/lib/i18n/t'
import { ProjectSettingsClient } from './settings-client'

interface Props {
  params: Promise<{ projectId: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params
  const p = await db.project.findUnique({ where: { id: projectId }, select: { name: true } })
  return { title: `Settings — ${p?.name ?? 'Project'}` }
}

export default async function ProjectSettingsPage({ params }: Props) {
  const { projectId } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const project = await db.project.findUnique({
    where: { id: projectId, archived_at: null },
    select: {
      id: true, name: true, description: true,
      domain_profile: true, confidentiality: true, config: true,
    },
  })
  if (!project) notFound()

  const instanceRole = (session.user as Record<string, unknown>).role as string | null ?? null
  const caller = { type: 'session' as const, userId: session.user.id, instanceRole }
  const permissions = await resolvePermissions(caller, projectId).catch(() => new Set<import('@/lib/auth/permissions').Permission>())

  if (!permissions.has('project:read')) redirect('/projects')

  const canEdit   = permissions.has('project:edit')
  const userMeta  = session.user as Record<string, unknown>
  const expertMode = Boolean(userMeta.expert_mode) || (userMeta.ui_level as string | undefined) === 'EXPERT'
  const locale     = getSessionLocale(userMeta)
  const t          = createT(locale)

  const config = (project.config ?? {}) as Record<string, unknown>

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">{t('project_settings.title')}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Configure domain profile, confidentiality and agent behaviour overrides.
        </p>
      </div>

      <ProjectSettingsClient
        projectId={projectId}
        name={project.name}
        description={project.description}
        domainProfile={project.domain_profile}
        confidentiality={project.confidentiality}
        config={config}
        canEdit={canEdit}
        expertMode={expertMode}
      />
    </div>
  )
}
