// app/(app)/analytics/page.tsx
// KPI dashboard — board-level analytics.
// UX spec §3.9 — Analytics.
//
// Auth:
//   instance_admin   → full view (all projects)
//   project admin    → scoped + anonymized (supply ?project_id=)
//   others           → /dashboard redirect
//
// Data comes from GET /api/analytics (internal session-auth route).
// Server Component — renders on each request for fresh data.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getInstanceRole, getSessionLocale } from '@/lib/auth/session-helpers'
import { createT } from '@/lib/i18n/t'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { AnalyticsResponse } from '@/lib/analytics/types'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

export const metadata: Metadata = { title: 'Analytics — Harmoven' }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, suffix = ''): string {
  if (n === null || n === undefined) return '—'
  return `${n.toLocaleString('en')}${suffix}`
}

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `$${n.toFixed(2)}`
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n.toFixed(1)}%`
}

interface KpiCardProps {
  label:    string
  value:    string
  delta?:   string | null
  trend?:   'up' | 'down' | 'neutral'
  goodWhen?: 'up' | 'down'
}

function KpiCard({ label, value, delta, trend, goodWhen }: KpiCardProps) {
  const isPositive = trend === goodWhen
  const TrendIcon  =
    trend === 'up'   ? TrendingUp :
    trend === 'down' ? TrendingDown  :
    Minus

  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
        <p className="text-2xl font-bold text-foreground">{value}</p>
        {delta && (
          <div className={`flex items-center gap-1 mt-1 text-xs ${isPositive ? 'text-success' : 'text-destructive'}`}>
            <TrendIcon className="h-3.5 w-3.5" />
            <span>{delta}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ project_id?: string }>
}) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = getInstanceRole(session.user as Record<string, unknown>)
  const locale       = getSessionLocale(session.user as Record<string, unknown>)
  const t            = createT(locale)
  const isAdmin      = instanceRole === 'instance_admin'

  const { project_id } = await searchParams

  // Non-admins must supply a project_id — they'll be redirected to dashboard
  // if they hit the root /analytics without a project scoping (don't expose existence).
  if (!isAdmin && !project_id) {
    redirect('/dashboard')
  }

  // Build query string for the internal API call — last 30 days default
  const now  = new Date()
  const from = new Date(now)
  from.setDate(from.getDate() - 30)
  const params = new URLSearchParams()
  params.set('from', from.toISOString())
  params.set('to',   now.toISOString())
  if (project_id) params.set('project_id', project_id)

  let data: AnalyticsResponse | null = null
  let fetchError: string | null = null

  try {
    const hdrs = await headers()
    const baseUrl = process.env.AUTH_URL ?? 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/analytics?${params.toString()}`, {
      headers: {
        Cookie:         hdrs.get('cookie') ?? '',
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      fetchError = (body as { error?: string }).error ?? `HTTP ${res.status}`
    } else {
      data = await res.json() as AnalyticsResponse
    }
  } catch (e) {
    fetchError = 'Could not load analytics data.'
  }

  const s = data?.summary

  return (
    <div className="space-y-8 animate-stagger">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('analytics.title')}</h1>
          {data && (
            <p className="text-sm text-muted-foreground mt-0.5">
              {new Date(data.period.from).toLocaleDateString('en')}
              {' — '}
              {new Date(data.period.to).toLocaleDateString('en')}
            </p>
          )}
        </div>
        {!isAdmin && project_id && (
          <Badge variant="pending">Project scope</Badge>
        )}
      </div>

      {/* Error state */}
      {fetchError && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            {fetchError}
          </CardContent>
        </Card>
      )}

      {/* KPI grid */}
      {s && (
        <>
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">{t('runs.labels.status')}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard label={t('analytics.kpis.runs_completed')} value={fmt(s.runs_total)} />
              <KpiCard label={t('analytics.kpis.runs_completed')} value={fmt(s.runs_completed)} />
              <KpiCard label={t('analytics.kpis.retention')}     value={fmtPct(s.completion_rate_pct)} />
              <KpiCard label={t('runs.labels.cost')}             value={fmtUsd(s.cost_per_run_usd)} />
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">{t('members.title')}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard label={t('analytics.kpis.active_users')} value={fmt(s.users_active)} />
              <KpiCard label={t('analytics.kpis.retention')}    value={fmtPct(s.retention_rate_pct)} />
              <KpiCard label={t('analytics.kpis.quality')}      value={s.avg_user_rating ? fmt(s.avg_user_rating, '/5') : '—'} />
              <KpiCard label={t('analytics.kpis.roi')}          value={fmtPct(s.approval_direct_rate_pct)} />
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">{t('analytics.kpis.roi')}</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiCard label={t('analytics.kpis.roi')}      value={fmtUsd(s.cost_total_usd)} />
              <KpiCard label={t('analytics.kpis.roi')}      value={fmtUsd(s.cost_per_active_user_usd)} />
              <KpiCard label={t('analytics.kpis.roi')}      value={s.estimated_hours_saved_total !== null ? fmt(s.estimated_hours_saved_total, 'h') : '—'} />
              <KpiCard label={t('analytics.kpis.roi')}      value={s.roi_multiplier !== null ? `${s.roi_multiplier.toFixed(1)}×` : '—'} goodWhen="up" />
            </div>
          </section>

          {/* By-profile breakdown */}
          {data!.by_profile.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">{t('analytics.by_profile')}</h2>
              <Card>
                <CardContent className="p-0 divide-y divide-surface-border">
                  {data!.by_profile.map((p) => (
                    <div key={p.profile} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <span className="font-medium text-foreground">{p.profile}</span>
                      <div className="flex items-center gap-6 text-muted-foreground text-xs">
                        <span>{fmt(p.runs)} runs</span>
                        <span>{fmtUsd(p.cost_usd)}</span>
                        <span>{Math.round(p.avg_duration_s)}s avg</span>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </section>
          )}

          {/* Board KPIs (top_kpis) */}
          {data!.top_kpis.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Board KPIs</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {data!.top_kpis.map((kpi) => (
                  <KpiCard
                    key={kpi.id}
                    label={kpi.label}
                    value={kpi.value}
                    delta={kpi.delta}
                    trend={kpi.trend}
                    goodWhen={kpi.good_when}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
