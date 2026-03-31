// app/(app)/projects/page.tsx
// Project list — sortable columns, search, pagination, configurable page size.
// Server Component; sort/order/page/q/size come from URL search params.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Plus } from 'lucide-react'
import {
  ProjectSearch, SortHeader, Pagination,
  type SortField,
} from './projects-controls'
import { PAGE_SIZES, type PageSize } from './projects-shared'
import { BUILT_IN_ROLES } from '@/lib/auth/built-in-roles'

export const metadata: Metadata = { title: 'Projects' }

const DEFAULT_PAGE_SIZE: PageSize = 10
const VALID_SORTS: SortField[] = ['updated_at', 'created_at', 'name', 'runs', 'cost']

interface PageProps {
  searchParams: Promise<{ sort?: string; order?: string; page?: string; q?: string; size?: string }>
}

export default async function ProjectsPage({ searchParams }: PageProps) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const sp = await searchParams
  const sort: SortField   = VALID_SORTS.includes(sp.sort as SortField) ? (sp.sort as SortField) : 'updated_at'
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'desc'
  const rawPage           = parseInt(sp.page ?? '1', 10)
  const page              = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1
  const q                 = (sp.q?.trim() ?? '').slice(0, 200)
  const rawSize           = parseInt(sp.size ?? '', 10)
  const pageSize: number  = (PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : DEFAULT_PAGE_SIZE

  const userId       = session.user.id
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin      = instanceRole === 'instance_admin'

  // Security: non-admin users see only projects they are members of.
  // Also resolve costGrantedProjectIds to enforce runs:read_costs per project.
  const memberships = isAdmin
    ? null
    : await db.projectMember.findMany({
        where: { user_id: userId },
        select: { project_id: true, role: true },
      })
  const memberProjectIds = isAdmin ? undefined : memberships!.map((m) => m.project_id)
  // Projects where the user's role grants runs:read_costs permission.
  const costGrantedProjectIds = new Set<string>(
    isAdmin
      ? [] // bypassed below via isAdmin flag
      : memberships!
          .filter((m) => (BUILT_IN_ROLES[m.role as keyof typeof BUILT_IN_ROLES] ?? []).includes('runs:read_costs'))
          .map((m) => m.project_id),
  )

  const baseWhere = {
    archived_at: null,
    ...(memberProjectIds !== undefined ? { id: { in: memberProjectIds } } : {}),
    ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
  }

  const projectInclude = {
    _count: { select: { runs: true } },
    runs: {
      where: { status: { in: ['RUNNING', 'PAUSED', 'PENDING'] } },
      select: { id: true, status: true },
      take: 10,
    },
  } as const

  // ── Fetch projects + total ───────────────────────────────────────────────
  let projects: Awaited<ReturnType<typeof db.project.findMany<{ include: typeof projectInclude }>>>
  let total: number

  if (sort === 'cost') {
    // Cost sort: aggregate SUM per project, sort in JS, paginate by sliced IDs.
    // take: 10_000 caps memory footprint for instance_admin on large installations.
    const allIds = (await db.project.findMany({ where: baseWhere, select: { id: true }, take: 10_000 })).map(p => p.id)
    total = allIds.length

    const costRows = await db.run.groupBy({
      by: ['project_id'],
      where: { project_id: { in: allIds } },
      _sum: { cost_actual_usd: true },
    })
    const costById = new Map(costRows.map(r => [r.project_id, Number(r._sum.cost_actual_usd ?? 0)]))

    const sortedIds = [...allIds].sort((a, b) => {
      const diff = (costById.get(a) ?? 0) - (costById.get(b) ?? 0)
      return order === 'asc' ? diff : -diff
    })

    const pageIds = sortedIds.slice((page - 1) * pageSize, page * pageSize)
    const unsorted = await db.project.findMany({ where: { id: { in: pageIds } }, include: projectInclude })
    const rankOf = new Map(pageIds.map((id, i) => [id, i]))
    projects = unsorted.sort((a, b) => (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0))
  } else {
    const orderBy =
      sort === 'runs'       ? { runs: { _count: order } } :
      sort === 'name'       ? { name: order } :
      sort === 'created_at' ? { created_at: order } :
                              { updated_at: order }

    ;[projects, total] = await Promise.all([
      db.project.findMany({ where: baseWhere, orderBy, skip: (page - 1) * pageSize, take: pageSize, include: projectInclude }),
      db.project.count({ where: baseWhere }),
    ])
  }

  // ── Cost sums for displayed projects (display column) ────────────────────
  const costRows = await db.run.groupBy({
    by: ['project_id'],
    where: { project_id: { in: projects.map(p => p.id) } },
    _sum: { cost_actual_usd: true },
  })
  const costByProject = new Map(costRows.map(r => [r.project_id, Number(r._sum.cost_actual_usd ?? 0)]))

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="space-y-4 animate-stagger">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Projects</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {total} project{total !== 1 ? 's' : ''}{q ? ` matching "${q}"` : ''}
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

      {/* Search */}
      <Suspense>
        <ProjectSearch defaultValue={q} />
      </Suspense>

      {/* Table */}
      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <span className="text-4xl opacity-30">⬡</span>
          <div>
            <p className="text-sm font-semibold text-foreground">
              {q ? 'No projects match your search' : 'No projects yet'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {q ? 'Try a different name.' : 'Create your first project to start running agents.'}
            </p>
          </div>
          {!q && (
            <Link
              href="/projects/new"
              className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-md bg-accent-amber text-[#111] text-xs font-semibold hover:bg-accent-amber-press transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New project
            </Link>
          )}
        </div>
      ) : (
        <div className="rounded-card border border-surface-border overflow-hidden">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-surface-border bg-surface-overlay/40">
                <Suspense>
                  <SortHeader field="name"       label="Project"  currentSort={sort} currentOrder={order} />
                  <SortHeader field="updated_at" label="Updated"  currentSort={sort} currentOrder={order} className="hidden sm:table-cell" />
                  <SortHeader field="created_at" label="Created"  currentSort={sort} currentOrder={order} className="hidden md:table-cell" />
                  <SortHeader field="runs"       label="Runs"     currentSort={sort} currentOrder={order} className="hidden sm:table-cell" />
                  <SortHeader field="cost"       label="Cost"     currentSort={sort} currentOrder={order} className="hidden sm:table-cell" />
                </Suspense>
                <th className="px-3 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em]">Domain</th>
                <th className="px-3 py-2 text-left text-[11px] font-medium text-muted-foreground uppercase tracking-[0.06em] hidden sm:table-cell">Active</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const activeCount  = project.runs.length
                const runningCount = project.runs.filter((r) => r.status === 'RUNNING').length
                const projectCost  = costByProject.get(project.id) ?? 0
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
                    <td className="px-3 py-2.5 font-mono text-muted-foreground whitespace-nowrap hidden sm:table-cell">
                      {new Date(project.updated_at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: '2-digit' })}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-muted-foreground whitespace-nowrap hidden md:table-cell">
                      {new Date(project.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: '2-digit' })}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-muted-foreground hidden sm:table-cell">
                      {project._count.runs}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-muted-foreground hidden sm:table-cell">
                      {(isAdmin || costGrantedProjectIds.has(project.id)) && projectCost > 0
                        ? `€${projectCost.toFixed(2)}`
                        : <span className="text-muted-foreground/40">—</span>}
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
                  </tr>
                )
              })}
            </tbody>
          </table>
          <Suspense>
            <Pagination page={page} totalPages={totalPages} total={total} pageSize={pageSize} />
          </Suspense>
        </div>
      )}
    </div>
  )
}
