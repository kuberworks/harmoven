// app/(app)/marketplace/browse-tab.tsx
// Browse tab — Server Component that renders plugins from enabled registry feeds.
// Displays plugin cards with capability type badges and unverified warnings.

import { db } from '@/lib/db/client'
import { decryptValue } from '@/lib/utils/credential-crypto-ext'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Package, AlertTriangle, Store } from 'lucide-react'
import { createT } from '@/lib/i18n/t'
import type { SupportedLocale } from '@/lib/i18n/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RegistryPlugin {
  pack_id?:         string
  id?:              string
  name:             string
  version?:         string
  author?:          string
  description?:     string
  capability_type?: string
  tags?:            string[]
  content_sha256?:  string
  source_url?:      string
}

interface RegistryFeed {
  plugins?: RegistryPlugin[]
  packs?:   RegistryPlugin[]
  skills?:  RegistryPlugin[]
}

interface FetchedRegistry {
  id:      string
  label:   string
  plugins: RegistryPlugin[]
  error?:  string
}

// ─── Fetch helper (server-side) ───────────────────────────────────────────────

async function fetchRegistryFeed(
  feedUrl: string,
  authHeaderEnc: string | null,
): Promise<{ plugins: RegistryPlugin[] } | { error: string }> {
  try {
    assertNotPrivateHost(feedUrl)
  } catch {
    return { error: 'URL blocked by SSRF protection' }
  }

  const headers: Record<string, string> = {}
  if (authHeaderEnc) {
    try { headers['Authorization'] = decryptValue(authHeaderEnc) } catch {/* skip */ }
  }

  try {
    const res = await fetch(feedUrl, {
      headers,
      next: { revalidate: 300 }, // 5-min cache edge
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }

    const text = await res.text()
    let parsed: RegistryFeed
    try {
      parsed = JSON.parse(text) as RegistryFeed
    } catch {
      return { error: 'Invalid response format (non-JSON)' }
    }

    const plugins: RegistryPlugin[] = parsed.plugins ?? parsed.packs ?? parsed.skills ?? []
    return { plugins }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export async function BrowseTab({ locale }: { locale?: SupportedLocale | string }) {
  const t = createT(locale ?? 'en')
  const registries = await db.marketplaceRegistry.findMany({
    where: { enabled: true },
    orderBy: { created_at: 'asc' },
  })

  if (registries.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <Store className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-foreground">{t('marketplace.browse.no_registry_title')}</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            {t('marketplace.browse.no_registry_hint')}
          </p>
        </CardContent>
      </Card>
    )
  }

  // Fetch all enabled registries in parallel
  const results = await Promise.all(
    registries.map(async (r): Promise<FetchedRegistry> => {
      const result = await fetchRegistryFeed(r.feed_url, r.auth_header_enc)
      if ('error' in result) return { id: r.id, label: r.label, plugins: [], error: result.error }
      return { id: r.id, label: r.label, plugins: result.plugins }
    })
  )

  const allPlugins = results.flatMap((r) =>
    r.plugins.map((p) => ({ ...p, _registry: r.label, _registryError: r.error }))
  )

  if (allPlugins.length === 0) {
    const hasErrors = results.some((r) => r.error)
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <Package className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-foreground">
            {hasErrors ? t('marketplace.browse.feed_error') : t('marketplace.browse.no_plugins')}
          </p>
          {results.filter((r) => r.error).map((r) => (
            <p key={r.id} className="text-xs text-destructive">
              {r.label}: {r.error}
            </p>
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Registry-level error banners */}
      {results.filter((r) => r.error).map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-2 rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span><strong>{r.label}</strong> — {r.error}</span>
        </div>
      ))}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {allPlugins.map((plugin, i) => {
          const packId = plugin.pack_id ?? plugin.id ?? `plugin-${i}`
          const isUnverified = !plugin.content_sha256
          return (
            <Card
              key={`${(plugin as { _registry: string })._registry}-${packId}`}
              className="rounded-xl border-border/50 bg-card/50 hover:border-border transition-colors"
            >
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{plugin.name}</p>
                    {plugin.version && (
                      <p className="text-xs font-mono text-muted-foreground">v{plugin.version}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {plugin.capability_type && (
                      <Badge variant="outline" className="text-xs py-0 font-mono">
                        {plugin.capability_type}
                      </Badge>
                    )}
                    {isUnverified && (
                      <Badge
                        variant="outline"
                        className="text-xs py-0 text-amber-400 border-amber-700 bg-amber-500/10"
                      title={t('marketplace.browse.unverified')}
                    >
                      <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                      {t('marketplace.browse.unverified')}
                      </Badge>
                    )}
                  </div>
                </div>

                {plugin.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{plugin.description}</p>
                )}

                <div className="flex flex-wrap gap-1">
                  {(plugin.tags ?? []).slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-muted/50 text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>

                <div className="pt-1">
                  <p className="text-[10px] text-muted-foreground">{t('marketplace.browse.source_label', { registry: (plugin as { _registry: string })._registry })}</p>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
