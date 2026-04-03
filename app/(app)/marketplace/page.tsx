// app/(app)/marketplace/page.tsx
// Browse + install domain packs from the Harmoven pack registry.
// UX spec §3.10 — Marketplace / Browse packs.
//
// v2: Three-tab layout — Browse (registry feeds) | Add from Git | Upload Package
// Server Component — shows installed packs from DB.

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Package, ShoppingBag, Loader2 } from 'lucide-react'
import { BrowseTab } from './browse-tab'
import { ImportFromUrlClient } from './import-from-url-client'
import { UploadTab } from './upload-tab'
import { getSessionLocale } from '@/lib/auth/session-helpers'
import { createT } from '@/lib/i18n/t'

export const metadata: Metadata = { title: 'Marketplace — Harmoven' }

const SOURCE_LABEL: Record<string, string> = {
  official: 'Official',
  git:      'Git',
  local:    'Local',
  hpkg:     'Package',
}

export default async function MarketplacePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin      = instanceRole === 'instance_admin'
  const locale       = getSessionLocale(session.user as Record<string, unknown>)
  const t            = createT(locale)

  // Show installed packs (all source types) ordered by recency
  const [installed, siEnabledSetting] = await Promise.all([
    db.mcpSkill.findMany({
      orderBy: { installed_at: 'desc' },
      select: {
        id:           true,
        name:         true,
        source_type:  true,
        version:      true,
        enabled:      true,
        scan_status:  true,
        installed_at: true,
        pending_update: true,
      },
    }),
    db.systemSetting.findUnique({ where: { key: 'marketplace.smart_import.enabled' } }),
  ])

  const smartImportEnabled = siEnabledSetting?.value !== 'false'

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground">Marketplace</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('marketplace.page_description')}
        </p>
      </div>

      {/* Tabs: Browse | Add from Git | Upload — admin sections only for admins */}
      {isAdmin && (
        <Tabs defaultValue="browse" className="space-y-4">
          <TabsList className="h-9">
            <TabsTrigger value="browse" className="text-xs h-7">{t('marketplace.tab.browse')}</TabsTrigger>
            <TabsTrigger value="git" className="text-xs h-7">{t('marketplace.tab.git')}</TabsTrigger>
            <TabsTrigger value="upload" className="text-xs h-7">{t('marketplace.tab.upload')}</TabsTrigger>
          </TabsList>

          <TabsContent value="browse">
            <Suspense fallback={
              <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('marketplace.browse.loading')}
              </div>
            }>
              <BrowseTab locale={locale} />
            </Suspense>
          </TabsContent>

          <TabsContent value="git">
            <div className="space-y-3 max-w-2xl">
              <p className="text-xs text-muted-foreground">
                {t('marketplace.add_from_git.description')}
              </p>
              <ImportFromUrlClient smartImportEnabled={smartImportEnabled} />
            </div>
          </TabsContent>

          <TabsContent value="upload">
            <UploadTab />
          </TabsContent>
        </Tabs>
      )}

      {/* Installed packs */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {t('marketplace.installed_section.title')}
          <span className="ml-2 font-normal normal-case text-muted-foreground">
            ({t('marketplace.installed_section.count', {
              active: String(installed.filter((p) => p.enabled).length),
              total:  String(installed.length),
            })})
          </span>
        </h2>

        {installed.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <ShoppingBag className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t('marketplace.installed_section.empty')}</p>
              {isAdmin && (
                <p className="text-xs text-muted-foreground">
                  {t('marketplace.installed_section.empty_hint')}
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0 divide-y divide-surface-border">
              {installed.map((pack) => (
                <div key={pack.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">{pack.name}</span>
                        {pack.version && (
                          <span className="text-xs font-mono text-muted-foreground">v{pack.version}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                        <span>{SOURCE_LABEL[pack.source_type] ?? pack.source_type}</span>
                        {pack.installed_at && (
                          <>
                            <span>·</span>
                            <span>{t('marketplace.installed_section.installed_on', { date: new Date(pack.installed_at).toLocaleDateString(locale) })}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pack.enabled ? (
                      <Badge variant="completed">{t('marketplace.installed_section.active')}</Badge>
                    ) : (
                      <Badge variant="pending">{t('marketplace.installed_section.disabled')}</Badge>
                    )}
                    {pack.scan_status === 'failed' && (
                      <Badge variant="failed">{t('marketplace.installed_section.scan_failed')}</Badge>
                    )}
                    {pack.pending_update !== null && pack.pending_update !== undefined && (
                      <Badge className="text-xs py-0 bg-amber-500/20 text-amber-400 border-amber-700">
                        {t('marketplace.installed_section.update_badge')}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  )
}
