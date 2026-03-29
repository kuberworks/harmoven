// app/(app)/admin/skills/page.tsx
// Admin — MCP Skills list with approve / enable / disable actions.
// Server Component + client actions. instance_admin only.
// UX spec §3.8 — Admin / MCP Skills.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Package } from 'lucide-react'
import { SkillActionsClient } from './skill-actions-client'

export const metadata: Metadata = { title: 'MCP Skills — Admin' }

const SCAN_VARIANT: Record<string, 'running' | 'completed' | 'failed' | 'pending'> = {
  passed:  'completed',
  failed:  'failed',
  pending: 'pending',
}

export default async function AdminSkillsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const skills = await db.mcpSkill.findMany({ orderBy: { installed_at: 'desc' } })

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">MCP Skills</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {skills.filter((s) => s.enabled).length} enabled / {skills.length} installed
        </p>
      </div>

      {skills.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Package className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No MCP skills installed yet.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-surface-border">
            {skills.map((skill) => (
              <div key={skill.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{skill.name}</span>
                    {skill.version && (
                      <span className="text-xs text-muted-foreground font-mono">v{skill.version}</span>
                    )}
                    <Badge variant={SCAN_VARIANT[skill.scan_status] ?? 'pending'}>
                      {skill.scan_status}
                    </Badge>
                    {skill.enabled && <Badge variant="completed">enabled</Badge>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
                    <span>{skill.source_type}</span>
                    {skill.source_url && (
                      <>
                        <span>·</span>
                        <span className="truncate max-w-[200px]">{skill.source_url}</span>
                      </>
                    )}
                    {skill.approved_by && (
                      <>
                        <span>·</span>
                        <span>Approved</span>
                      </>
                    )}
                  </div>
                </div>
                <SkillActionsClient
                  skillId={skill.id}
                  enabled={skill.enabled}
                  scanStatus={skill.scan_status}
                  approvedBy={skill.approved_by}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
