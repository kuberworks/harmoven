// app/(app)/analytics/users/page.tsx
// Per-user contribution breakdown.
// Uses GET /api/analytics?breakdown=user for data.
// UX spec §3.9 — Analytics › Users tab.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Users, Star, Clock } from 'lucide-react'
import type { AnalyticsResponse, UserBreakdown } from '@/lib/analytics/types'

export const metadata: Metadata = { title: 'Users · Analytics' }

function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en', { maximumFractionDigits: digits })
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n.toFixed(1)}%`
}

function fmtHours(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n.toFixed(1)}h`
}

function RatingBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>
  const pct = Math.round((value / 5) * 100)
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 rounded-full bg-surface-border overflow-hidden">
        <div className="h-full rounded-full bg-amber-400" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{value.toFixed(1)}</span>
    </div>
  )
}

export default async function AnalyticsUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ project_id?: string; from?: string; to?: string }>
}) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin = instanceRole === 'instance_admin'
  if (!isAdmin) redirect('/dashboard')

  const sp = await searchParams
  const qs = new URLSearchParams()
  if (sp.project_id) qs.set('project_id', sp.project_id)
  if (sp.from)       qs.set('from', sp.from)
  if (sp.to)         qs.set('to', sp.to)
  qs.set('breakdown', 'user')

  // Fetch from internal analytics API (session cookie forwarded via headers)
  let users: UserBreakdown[] = []
  try {
    const baseUrl = process.env.AUTH_URL ?? 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/analytics?${qs.toString()}`, {
      headers: await headers(),
      next:    { revalidate: 300 },
    })
    if (res.ok) {
      const data = (await res.json()) as AnalyticsResponse
      users = data.by_user ?? []
    }
  } catch {
    // Degrade gracefully — empty table shown
  }

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">User contributions</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Contribution breakdown by user for the selected period.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
            Contributors
            <Badge variant="secondary" className="text-xs">{users.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {users.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Users className="h-7 w-7 text-muted-foreground/30" aria-hidden />
              <p className="text-sm text-muted-foreground">No contributor data for this period.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-medium">User</th>
                    <th className="px-4 py-3 text-right font-medium">Runs</th>
                    <th className="px-4 py-3 text-right font-medium">Contribution</th>
                    <th className="px-4 py-3 text-left font-medium">Rating</th>
                    <th className="px-4 py-3 text-right font-medium">Hours saved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border">
                  {users.map((u) => (
                    <tr key={u.user_id} className="hover:bg-surface-hover transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <span className="text-xs font-semibold text-primary">
                              {u.display_name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <span className="text-sm font-medium text-foreground truncate">{u.display_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {fmt(u.runs_authored)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span className="font-medium text-foreground">{fmtPct(u.avg_contribution_pct)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <RatingBar value={u.avg_rating} />
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        <span className="flex items-center justify-end gap-1">
                          <Clock className="h-3 w-3" />
                          {fmtHours(u.hours_saved)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
