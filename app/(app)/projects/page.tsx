// app/(app)/projects/page.tsx
// Project list — shows all projects the user can see.
// Server Component; data fetched from DB.
// Design: table-style list matching harmoven_main_v5.html (tbl pattern).

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Plus } from 'lucide-react'

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
      {/* Header — matches mockup .ph pattern */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-bold text-foreground">Projects</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {projects.length} project{projects.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-md bg-accent-amber text-[#111] text-xs font-semibold hover:bg-accent-amber-press transition-colors shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          New project
        </Link>
      </div>

      {/* Table — matches mockup .tbl pattern */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <span className="text-4xl opacity-30">⬡</span>
          <div>
            <p className="text-sm font-semibold text-foreground">No projects yet</p>
            <p className="text-xs text-muted-foreground mt-1">Create your first project to start running agents.</p>
          </div>
          <Link
            href="/projects/new"
            className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-md bg-accent-amber text-[#111] text-xs font-semibold hover:bg-accent-amber-press transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New project
          </Link>
        </div>
      ) : (
        <div className="rounded-card border border-surface-border overflow-hidden">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-surface-border">
                <th className="text-left px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em]">Project</th>
                <th className="text-left px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em]">Domain</th>
                <th className="text-left px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em] hidden sm:table-cell">Active</th>
                <th className="text-left px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em] hidden sm:table-cell">Runs</th>
                <th className="text-right px-3 py-2 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em]">Updated</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const activeCount = project.runs.length
                const runningCount = project.runs.filter(r => r.status === 'RUNNING').length
                return (
                  <tr
                    key={project.id}
                    className="border-b border-surface-border last:border-0 hover:bg-surface-hover transition-colors cursor-pointer"
                  >
                    <td className="px-3 py-2.5">
                      <Link href={`/projects/${project.id}`} className="block after:absolute after:inset-0 relative">
                        <span className="font-medium text-foreground">{project.name}</span>
                        {project.description && (
                          <span className="block text-[11px] text-muted-foreground truncate max-w-[240px]">{project.description}</span>
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      {project.domain_profile ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono border border-surface-border text-muted-foreground bg-surface-overlay">
                          {project.domain_profile}
                        </span>
                      ) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-3 py-2.5 hidden sm:table-cell">
                      {activeCount > 0 ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono border ${
                          runningCount > 0
                            ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
                            : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                        }`}>
                          {runningCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />}
                          {activeCount}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-muted-foreground hidden sm:table-cell">
                      {project._count.runs}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-muted-foreground text-right whitespace-nowrap">
                      {new Date(project.updated_at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
