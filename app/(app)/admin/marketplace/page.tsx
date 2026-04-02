// app/(app)/admin/marketplace/page.tsx
// Admin → Marketplace Settings
// Server Component. instance_admin guard. Fetches initial data server-side.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { decryptValue } from '@/lib/utils/credential-crypto-ext'
import { AdminMarketplaceClient } from './admin-marketplace-client'

export const metadata: Metadata = { title: 'Marketplace — Admin' }

export default async function AdminMarketplacePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')
  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  if (instanceRole !== 'instance_admin') redirect('/dashboard')

  const [whitelist, registries, tokens, cronSetting, lastScheduled, siSettings, llmProfiles] = await Promise.all([
    db.gitUrlWhitelistEntry.findMany({ orderBy: { created_at: 'asc' } }),
    db.marketplaceRegistry.findMany({ orderBy: { created_at: 'asc' } }),
    db.gitProviderToken.findMany({ orderBy: { created_at: 'asc' } }),
    db.systemSetting.findUnique({ where: { key: 'marketplace.cron.last_scheduled_run_at' } }),
    db.systemSetting.findUnique({ where: { key: 'marketplace.cron.last_run_at' } }),
    db.systemSetting.findMany({
      where: { key: { startsWith: 'marketplace.smart_import.' } },
    }),
    db.llmProfile.findMany({
      where:   { enabled: true },
      orderBy: { id: 'asc' },
      select:  { id: true, provider: true, model_string: true, tier: true },
    }),
  ])

  const now = new Date()

  const serialisedWhitelist = whitelist.map((e) => ({
    id:          e.id,
    label:       e.label,
    pattern:     e.pattern,
    description: e.description,
    is_builtin:  e.is_builtin,
    enabled:     e.enabled,
    created_at:  e.created_at.toISOString(),
  }))

  const serialisedRegistries = registries.map((r) => ({
    id:                r.id,
    label:             r.label,
    feed_url:          r.feed_url,
    has_auth:          r.auth_header_enc !== null,
    is_builtin:        r.is_builtin,
    enabled:           r.enabled,
    last_fetched_at:   r.last_fetched_at?.toISOString() ?? null,
    last_fetch_status: r.last_fetch_status,
    created_at:        r.created_at.toISOString(),
  }))

  const serialisedTokens = tokens.map((t) => {
    let expiry_status: 'valid' | 'expiring_soon' | 'expired' = 'valid'
    if (t.expires_at) {
      const diff = t.expires_at.getTime() - now.getTime()
      if (diff < 0) expiry_status = 'expired'
      else if (diff < 7 * 24 * 60 * 60 * 1000) expiry_status = 'expiring_soon'
    }
    return {
      id:            t.id,
      label:         t.label,
      host_pattern:  t.host_pattern,
      has_token:     t.token_enc !== null,
      enabled:       t.enabled,
      expires_at:    t.expires_at?.toISOString() ?? null,
      expiry_status,
      created_at:    t.created_at.toISOString(),
    }
  })

  // Cron health
  const lastRunAt     = cronSetting?.value ? new Date(cronSetting.value as string) : null
  const lastSchedAt   = lastScheduled?.value ? new Date(lastScheduled.value as string) : null
  const pendingCount  = await db.mcpSkill.count({ where: { pending_update: { not: undefined } } })

  let health: string
  if (!lastSchedAt) {
    health = 'NOT_CONFIGURED'
  } else {
    const staleThresholdMs = 26 * 60 * 60 * 1000 // 26h
    const isStale          = now.getTime() - lastSchedAt.getTime() > staleThresholdMs
    if (isStale) {
      health = 'STALE'
    } else if (pendingCount > 0) {
      health = 'UPDATES_AVAILABLE'
    } else {
      health = 'OK'
    }
  }

  const cronHealth = {
    health,
    last_run_at:           lastRunAt?.toISOString() ?? null,
    last_scheduled_run_at: lastSchedAt?.toISOString() ?? null,
    last_run_status:       null,
    last_run_summary:      null,
    pending_updates_count: pendingCount,
  }

  // Smart Import config
  const siMap: Record<string, string> = {}
  for (const row of siSettings) { siMap[row.key] = row.value as string }
  const initialSmartImport = {
    enabled:            siMap['marketplace.smart_import.enabled'] !== 'false',
    provider_id:        siMap['marketplace.smart_import.provider_id'] ?? null,
    model:              siMap['marketplace.smart_import.model'] ?? null,
    max_tokens:         parseInt(siMap['marketplace.smart_import.max_tokens'] ?? '4000', 10),
    preview_ttl_hours:  parseInt(siMap['marketplace.smart_import.preview_ttl_hours'] ?? '24', 10),
    monthly_budget_usd: siMap['marketplace.smart_import.monthly_budget_usd']
      ? parseFloat(siMap['marketplace.smart_import.monthly_budget_usd'])
      : null,
  }

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Marketplace</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Gérez les sources d&apos;installation, les autorisations Git et les vérifications automatiques.
        </p>
      </div>

      <AdminMarketplaceClient
        initialWhitelist={serialisedWhitelist}
        initialRegistries={serialisedRegistries}
        initialTokens={serialisedTokens}
        cronHealth={cronHealth}
        initialSmartImport={initialSmartImport}
        llmProfiles={llmProfiles}
      />
    </div>
  )
}
