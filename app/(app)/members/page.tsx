// app/(app)/members/page.tsx
// Organisation members — search-first view.
// Server Component. Requires admin or instance_admin role.
//
// No full list is rendered: the user must type to search.
// This prevents passive bulk extraction of organisation membership data.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getInstanceRole } from '@/lib/auth/session-helpers'
import { MembersSearchClient } from './members-search-client'

export const metadata: Metadata = { title: 'Project access' }

export default async function MembersPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = getInstanceRole(session.user as Record<string, unknown>)
  if (instanceRole !== 'admin' && instanceRole !== 'instance_admin') redirect('/dashboard')

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Project access</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Find the projects associated with a person.
        </p>
      </div>

      <MembersSearchClient isInstanceAdmin={instanceRole === 'instance_admin'} />
    </div>
  )
}
