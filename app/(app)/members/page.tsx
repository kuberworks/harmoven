// app/(app)/members/page.tsx
// Organization members — cross-project view.
// Server Component. Requires admin or instance_admin role.
//
// Shows every user who is a member of at least one project,
// with their project memberships and roles listed inline.
// instance_admin users are also listed even without explicit memberships.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getInstanceRole } from '@/lib/auth/session-helpers'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Users } from 'lucide-react'

export const metadata: Metadata = { title: 'Members' }

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

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Members</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {grouped.length} members across{' '}
          {new Set(memberships.map((m) => m.project.id)).size} projects
        </p>
      </div>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Users className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No project members yet. Add members from a project's settings page.
            </p>
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
                    <span
                      key={e.project.id}
                      className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-hover px-2 py-0.5 text-xs text-foreground"
                    >
                      <span className="font-medium">{e.project.name}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">
                        {e.role.display_name ?? e.role.name}
                      </span>
                    </span>
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
