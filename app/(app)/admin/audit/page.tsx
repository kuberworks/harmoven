// app/(app)/admin/audit/page.tsx
// Full instance audit log — last 500 entries, client-side filter/pagination.
// Server Component. instance_admin or admin:audit permission required.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { AuditClient } from './audit-client'

export const metadata: Metadata = { title: 'Audit log · Admin' }

export default async function AdminAuditPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const u = session.user as Record<string, unknown>
  const instanceRole = u.role as string | null

  // Only instance_admin may view the full audit log
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const rows = await db.auditLog.findMany({
    orderBy: { timestamp: 'desc' },
    take:    500,
    select: {
      id:          true,
      timestamp:   true,
      run_id:      true,
      node_id:     true,
      actor:       true,
      action_type: true,
      payload:     true,
    },
  })

  const entries = rows.map((r) => ({
    id:         r.id,
    timestamp:  r.timestamp.toISOString(),
    runId:      r.run_id ?? null,
    nodeId:     r.node_id ?? null,
    actor:      r.actor,
    actionType: r.action_type,
    payload:    r.payload as Record<string, unknown> | null,
  }))

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Audit log</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Last 500 system events. Filtered to the most recent 500 entries — use the API for full export.
        </p>
      </div>
      <AuditClient entries={entries} />
    </div>
  )
}
