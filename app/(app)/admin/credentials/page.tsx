// app/(app)/admin/credentials/page.tsx
// Instance-admin–only credential vault.
// Lists all ProjectCredentials (name + metadata only — never value_enc).
// Server Component. Redirects non-admins.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { CredentialsClient } from './credentials-client'

export const metadata: Metadata = { title: 'Credentials · Admin' }

export default async function AdminCredentialsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const rows = await db.projectCredential.findMany({
    select: {
      id:           true,
      name:         true,
      type:         true,
      host_pattern: true,
      created_at:   true,
      last_used_at: true,
      rotated_at:   true,
      project: {
        select: { id: true, name: true },
      },
    },
    orderBy: { created_at: 'desc' },
  })

  const credentials = rows.map((r) => ({
    id:          r.id,
    name:        r.name,
    type:        r.type as string,
    projectName: r.project.name,
    projectId:   r.project.id,
    hostPattern: r.host_pattern,
    createdAt:   r.created_at.toISOString(),
    lastUsedAt:  r.last_used_at?.toISOString() ?? null,
    rotatedAt:   r.rotated_at?.toISOString() ?? null,
  }))

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Credential vault</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Encrypted secrets injected into agent HTTP requests. Values are write-only.
        </p>
      </div>
      {/* @ts-expect-error type string vs CredentialType safely narrows in client */}
      <CredentialsClient credentials={credentials} />
    </div>
  )
}
