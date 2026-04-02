// app/(app)/members/page.tsx
// Organisation members — search-first view.
// Server Component. Requires admin or instance_admin role.
//
// No full list is rendered: the user must type to search.
// This prevents passive bulk extraction of organisation membership data.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { getInstanceRole } from '@/lib/auth/session-helpers'
import { Info, ArrowRight } from 'lucide-react'
import { MembersSearchClient } from './members-search-client'

export const metadata: Metadata = { title: 'Organisation members' }

export default async function MembersPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = getInstanceRole(session.user as Record<string, unknown>)
  if (instanceRole !== 'admin' && instanceRole !== 'instance_admin') redirect('/dashboard')

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Organisation members</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Who has access to which project.
        </p>
      </div>

      {/* Context banner */}
      <div className="flex items-start gap-3 rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-[var(--accent-amber-9)]" />
        <div className="space-y-1">
          <p>
            Search for a person to see their <strong className="text-foreground">project memberships</strong>.
            This page does not manage accounts.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
            <span className="flex items-center gap-1">
              To add someone to a project →
              <Link href="/projects" className="inline-flex items-center gap-0.5 text-[var(--accent-amber-9)] hover:underline">
                Projects <ArrowRight className="h-3 w-3" />
              </Link>
              then <span className="font-medium text-foreground">Settings → Members</span>.
            </span>
            {instanceRole === 'instance_admin' && (
              <span className="flex items-center gap-1">
                To create or delete accounts →
                <Link href="/admin/users" className="inline-flex items-center gap-0.5 text-[var(--accent-amber-9)] hover:underline">
                  Admin → Users <ArrowRight className="h-3 w-3" />
                </Link>.
              </span>
            )}
          </div>
        </div>
      </div>

      <MembersSearchClient isInstanceAdmin={instanceRole === 'instance_admin'} />
    </div>
  )
}


import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { getInstanceRole } from '@/lib/auth/session-helpers'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Users, Info, ArrowRight } from 'lucide-react'

export const metadata: Metadata = { title: 'Organisation members' }

export default async function MembersPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = getInstanceRole(session.user as Record<string, unknown>)
  if (instanceRole !== 'admin' && instanceRole !== 'instance_admin') redirect('/dashboard')

  // All project memberships with user + project + role info
  const memberships = await db.projectMember.findMany({
    orderBy: [{ user: { name: 'asc' } }, { project: { name: 'asc' } }],
    select: {
      added_at: true,
      user:    { select: { id: true, name: true, email: true, role: true } },
      project: { select: { id: true, name: true } },
      role:    { select: { name: true, display_name: true, is_builtin: true } },
    },
  })

  // Group by user
  type MembershipEntry = (typeof memberships)[number]
  const byUser = new Map<string, { user: MembershipEntry['user']; entries: MembershipEntry[] }>()
  for (const m of memberships) {
    const existing = byUser.get(m.user.id)
    if (existing) {
      existing.entries.push(m)
    } else {
      byUser.set(m.user.id, { user: m.user, entries: [m] })
    }
  }

  const grouped = Array.from(byUser.values())
  const projectCount = new Set(memberships.map((m) => m.project.id)).size

  // Collect all projects for the "add member" hint
  const projects = await db.project.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
    take: 50,
  })

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Organisation members</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Who has access to what — {grouped.length} {grouped.length === 1 ? 'person' : 'people'} across {projectCount} {projectCount === 1 ? 'project' : 'projects'}.
        </p>
      </div>

      {/* Context banner */}
      <div className="flex items-start gap-3 rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-[var(--accent-amber-9)]" />
        <div className="space-y-1">
          <p>
            This page shows <strong className="text-foreground">project memberships</strong> — who can access which project and with what role.
            It does <em>not</em> manage user accounts.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
            <span className="flex items-center gap-1">
              To <strong className="text-foreground">add someone to a project</strong>, go to
              <Link href="/projects" className="inline-flex items-center gap-0.5 text-[var(--accent-amber-9)] hover:underline">
                Projects <ArrowRight className="h-3 w-3" />
              </Link>
              then <span className="font-medium text-foreground">Settings → Members</span>.
            </span>
            {instanceRole === 'instance_admin' && (
              <span className="flex items-center gap-1">
                To <strong className="text-foreground">create or delete accounts</strong>, go to
                <Link href="/admin/users" className="inline-flex items-center gap-0.5 text-[var(--accent-amber-9)] hover:underline">
                  Admin → Users <ArrowRight className="h-3 w-3" />
                </Link>.
              </span>
            )}
          </div>
        </div>
      </div>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Users className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No project members yet.
            </p>
            {projects.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Add members from a project's{' '}
                <Link href={`/projects/${projects[0].id}/members`} className="text-[var(--accent-amber-9)] hover:underline">
                  Members settings page
                </Link>.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-surface-border">
            {grouped.map(({ user, entries }) => (
              <div key={user.id} className="px-4 py-3">
                {/* User row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{user.name}</span>
                  {user.role === 'instance_admin' && (
                    <Badge variant="secondary" className="text-xs">instance admin</Badge>
                  )}
                  {user.role === 'admin' && (
                    <Badge variant="secondary" className="text-xs">admin</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{user.email}</p>

                {/* Project memberships */}
                <div className="mt-2 flex flex-wrap gap-2">
                  {entries.map((e) => (
                    <Link
                      key={e.project.id}
                      href={`/projects/${e.project.id}/members`}
                      className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-hover px-2 py-0.5 text-xs text-foreground hover:border-muted-foreground transition-colors"
                    >
                      <span className="font-medium">{e.project.name}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">
                        {e.role.display_name ?? e.role.name}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
