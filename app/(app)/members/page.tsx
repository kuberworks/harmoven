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
