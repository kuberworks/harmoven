// app/(app)/marketplace/page.tsx
// Marketplace — Agent Skills hub.
// Tab layout: Agent Skills (all users) | Browse | Add from Git | Upload (admin only)
// Server Component. Installed skills tab is the default/first tab.

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2 } from 'lucide-react'
import { BrowseTab } from './browse-tab'
import { ImportFromUrlClient } from './import-from-url-client'
import { UploadTab } from './upload-tab'
import { InstalledPacksTab, type InstalledSkill } from './installed-packs-tab'
import { getSessionLocale } from '@/lib/auth/session-helpers'
import { createT } from '@/lib/i18n/t'

export const metadata: Metadata = { title: 'Marketplace — Harmoven' }

export default async function MarketplacePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin      = instanceRole === 'instance_admin'
  const locale       = getSessionLocale(session.user as Record<string, unknown>)
  const t            = createT(locale)

  const [rawSkills, siEnabledSetting] = await Promise.all([
    db.mcpSkill.findMany({
      orderBy: { installed_at: 'desc' },
      select: {
        id:              true,
        name:            true,
        pack_id:         true,
        source_type:     true,
        source_url:      true,
        source_ref:      true,
        version:         true,
        author:          true,
        tags:            true,
        capability_type: true,
        enabled:         true,
        scan_status:     true,
        installed_at:    true,
        pending_update:  true,
        approved_by:     true,
        config:          true,
      },
    }),
    db.systemSetting.findUnique({ where: { key: 'marketplace.smart_import.enabled' } }),
  ])

  const smartImportEnabled = siEnabledSetting?.value !== 'false'

  // Serialize for Client Component boundary
  const skills: InstalledSkill[] = rawSkills.map((s) => ({
    ...s,
    installed_at: s.installed_at.toISOString(),
    config: (s.config ?? {}) as Record<string, unknown>,
  }))

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground">Marketplace</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('marketplace.page_description')}
        </p>
      </div>

      {/* Tabs — "Agent Skills" always first/default; admin import tabs appended */}
      <Tabs defaultValue="installed" className="space-y-4">
        <TabsList className="h-9">
          <TabsTrigger value="installed" className="text-xs h-7">
            {t('marketplace.tab.installed')}
            {skills.length > 0 && (
              <span className="ml-1.5 tabular-nums text-[10px] opacity-60">
                {skills.filter((s) => s.enabled).length}/{skills.length}
              </span>
            )}
          </TabsTrigger>
          {isAdmin && (
            <>
              <TabsTrigger value="browse" className="text-xs h-7">{t('marketplace.tab.browse')}</TabsTrigger>
              <TabsTrigger value="git"    className="text-xs h-7">{t('marketplace.tab.git')}</TabsTrigger>
              <TabsTrigger value="upload" className="text-xs h-7">{t('marketplace.tab.upload')}</TabsTrigger>
            </>
          )}
        </TabsList>

        {/* Agent Skills tab */}
        <TabsContent value="installed">
          <InstalledPacksTab skills={skills} isAdmin={isAdmin} locale={locale} />
        </TabsContent>

        {/* Admin-only tabs */}
        {isAdmin && (
          <>
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
          </>
        )}
      </Tabs>
    </div>
  )
}
