// app/(app)/admin/page.tsx
// Admin dashboard — instance overview: user count, LLM profiles, skills, run stats.
// Server Component. instance_admin only — redirects others.
// UX spec §3.8 — Admin dashboard.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Users, Cpu, Package, Activity, Settings, ChevronRight } from 'lucide-react'

export const metadata: Metadata = { title: 'Admin' }

export default async function AdminPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const [userCount, llmCount, runStats] = await Promise.all([
    db.user.count(),
    db.llmProfile.count({ where: { enabled: true } }),
    db.run.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
  ])

  const activeRuns = runStats.find((r) => r.status === 'RUNNING')?._count.status ?? 0
  const completedToday = await db.run.count({
    where: {
      status: 'COMPLETED',
      completed_at: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
  })

  const adminLinks = [
    { href: '/admin/users',   icon: Users,    label: 'Users',          desc: 'Manage accounts, roles, bans' },
    { href: '/admin/models',  icon: Cpu,      label: 'LLM Models',     desc: 'Providers and profiles' },
    { href: '/admin/skills',  icon: Package,  label: 'MCP Skills',     desc: 'Install, approve, revoke' },
    { href: '/analytics',     icon: Activity, label: 'Analytics',      desc: 'Usage KPIs and ROI' },
    { href: '/admin/instance',icon: Settings, label: 'Instance config', desc: 'orchestrator.yaml settings' },
  ]

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Administration</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Instance overview and management.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Users',         value: userCount,      icon: Users  },
          { label: 'LLM profiles',  value: llmCount,       icon: Cpu    },
          { label: 'Active runs',   value: activeRuns,     icon: Activity },
          { label: 'Done today',    value: completedToday, icon: Activity },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="p-4 flex items-center gap-3">
              <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-xl font-bold text-foreground tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Quick nav */}
      <div className="flex flex-col divide-y divide-surface-border rounded-card border border-surface-border overflow-hidden">
        {adminLinks.map(({ href, icon: Icon, label, desc }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center justify-between gap-4 px-4 py-3 bg-surface-raised hover:bg-surface-hover transition-colors group"
          >
            <div className="flex items-center gap-3">
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  )
}
