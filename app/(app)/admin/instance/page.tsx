// app/(app)/admin/instance/page.tsx
// Admin — Instance configuration: security settings, RGPD policy, health.
// Fixes dead link from admin dashboard quick-nav (ARCHITECTURE_REVIEW.md §3.4).
// instance_admin only.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { InstanceSecurityClient }    from './security-client'
import { OrchestratorConfigClient }  from '@/components/admin/OrchestratorConfigClient'
import { readOrchestratorYaml }      from '@/lib/config-git/orchestrator-config'

export const metadata: Metadata = { title: 'Instance — Admin' }

async function fetchJson<T>(url: string, hdrs: Headers): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Cookie: hdrs.get('cookie') ?? '' },
      cache: 'no-store',
    })
    if (!res.ok) return null
    return res.json() as Promise<T>
  } catch {
    return null
  }
}

export default async function AdminInstancePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const hdrs   = await headers()
  const base   = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  const [security, health, orchestratorRaw, rgpd] = await Promise.all([
    fetchJson<{
      mfa_required_for_admin: boolean
      env_override_active: boolean
    }>(`${base}/api/admin/security`, hdrs),
    fetchJson<{ status: string; version?: string; db?: string; uptime?: number }>(
      `${base}/api/health`,
      hdrs,
    ),
    readOrchestratorYaml(),
    fetchJson<{
      maintenance_enabled: boolean
      data_retention_days: number
      env_override_active: boolean
    }>(`${base}/api/admin/rgpd`, hdrs),
  ])

  return (
    <div className="space-y-8 animate-stagger max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Instance settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Security policies and system health for this Harmoven instance.
        </p>
      </div>

      {/* Health */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">System health</h2>
        <Card>
          <CardContent className="pt-4 pb-4 divide-y divide-surface-border">
            <div className="flex items-center justify-between py-2 text-sm">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={health?.status === 'ok' ? 'completed' : 'failed'}>
                {health?.status ?? 'unknown'}
              </Badge>
            </div>
            {health?.version && (
              <div className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted-foreground">Version</span>
                <span className="font-mono text-foreground">{health.version}</span>
              </div>
            )}
            {health?.db && (
              <div className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted-foreground">Database</span>
                <Badge variant={health.db === 'ok' ? 'completed' : 'failed'}>{health.db}</Badge>
              </div>
            )}
            {health?.uptime !== undefined && (
              <div className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted-foreground">Uptime</span>
                <span className="font-mono text-foreground">
                  {Math.floor(health.uptime / 3600)}h {Math.floor((health.uptime % 3600) / 60)}m
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Security settings */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Security policy</h2>
        {security?.env_override_active && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
            Environment variable override active — HARMOVEN_ENFORCE_ADMIN_MFA=false is set.
            DB settings are ignored for MFA enforcement.
          </div>
        )}
        <InstanceSecurityClient
          mfaRequiredForAdmin={security?.mfa_required_for_admin ?? true}
          envOverrideActive={security?.env_override_active ?? false}
        />
      </section>

      {/* RGPD / Data retention */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Data retention (GDPR)</h2>
        {(!rgpd || !rgpd.maintenance_enabled) && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-300">
            <strong>Warning:</strong> Automated retention crons are <strong>disabled</strong>. Session IP
            addresses and run content will accumulate indefinitely — this may violate Art.&nbsp;5&nbsp;§1(e) GDPR
            (storage limitation).{' '}
            {rgpd?.env_override_active
              ? 'Override active via RGPD_MAINTENANCE_ENABLED=false env var — remove it to re-enable.'
              : 'Enable maintenance via the GDPR settings endpoint or set RGPD_MAINTENANCE_ENABLED=true.'}
          </div>
        )}
        <Card>
          <CardContent className="pt-4 pb-4 divide-y divide-surface-border text-sm">
            <div className="flex items-center justify-between py-2">
              <span className="text-muted-foreground">Automated purge crons</span>
              <Badge variant={rgpd?.maintenance_enabled ? 'completed' : 'failed'}>
                {rgpd?.maintenance_enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-muted-foreground">Run data retention</span>
              <span className="font-mono text-foreground text-xs">
                {rgpd ? `${rgpd.data_retention_days} days` : '—'}
              </span>
            </div>
            {rgpd?.env_override_active && (
              <div className="py-2 text-xs text-amber-400">
                RGPD_MAINTENANCE_ENABLED=false env override is active — DB settings are ignored.
              </div>
            )}
            <div className="py-2 text-xs text-muted-foreground">
              Non-EU providers (jurisdiction: <span className="font-mono">us</span>,{' '}
              <span className="font-mono">cn</span>) require a valid Art.&nbsp;44 transfer
              framework (SCC or adequacy decision). Configure provider jurisdictions in{' '}
              <a href="/admin/models" className="underline hover:text-foreground">AI Models</a>.
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Instance configuration (orchestrator.yaml) */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Instance configuration</h2>
        <p className="text-xs text-muted-foreground">
          These settings are persisted to <span className="font-mono">orchestrator.yaml</span> and versioned in config.git.
        </p>
        <OrchestratorConfigClient initial={orchestratorRaw} />
      </section>

      {/* Instance info */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Instance info</h2>
        <Card>
          <CardContent className="pt-4 pb-4 divide-y divide-surface-border text-sm">
            <div className="flex items-center justify-between py-2">
              <span className="text-muted-foreground">URL</span>
              <span className="font-mono text-foreground text-xs">{base}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-muted-foreground">Deployment mode</span>
              <span className="text-foreground">{process.env.DEPLOYMENT_MODE ?? 'docker'}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-muted-foreground">Node.js</span>
              <span className="font-mono text-foreground text-xs">{process.version}</span>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
