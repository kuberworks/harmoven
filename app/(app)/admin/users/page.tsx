// app/(app)/admin/users/page.tsx
// Admin — user management list.
// Server Component. instance_admin only.
// UX spec §3.8 — Admin / Users.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { UserActionsClient } from './user-actions-client'

export const metadata: Metadata = { title: 'Users — Admin' }

export default async function AdminUsersPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const users = await db.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id:             true,
      name:           true,
      email:          true,
      role:           true,
      banned:         true,
      banReason:      true,
      emailVerified:  true,
      createdAt:      true,
      twoFactorEnabled: true,
    },
  })

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{users.length} accounts</p>
      </div>

      <Card>
        <CardContent className="p-0 divide-y divide-surface-border">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{u.name}</span>
                  {u.role === 'instance_admin' && (
                    <Badge variant="secondary" className="text-xs">admin</Badge>
                  )}
                  {u.banned && (
                    <Badge variant="failed" className="text-xs">banned</Badge>
                  )}
                  {!u.emailVerified && (
                    <Badge variant="pending" className="text-xs">unverified</Badge>
                  )}
                  {u.twoFactorEnabled && (
                    <Badge variant="secondary" className="text-xs">2FA</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{u.email}</p>
                <p className="text-xs text-muted-foreground">
                  Joined {new Date(u.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              <UserActionsClient
                userId={u.id}
                banned={u.banned ?? false}
                isSelf={u.id === session.user.id}
              />
            </div>
          ))}
          {users.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-10">No users found.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
