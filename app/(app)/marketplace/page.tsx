// app/(app)/marketplace/page.tsx
// Browse + install domain packs from the Harmoven pack registry.
// UX spec §3.10 — Marketplace / Browse packs.
//
// Server Component — shows installed packs from DB.
// InstallClient handles the install form (admin only).

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Package, ShoppingBag } from 'lucide-react'
import { InstallPackClient } from './install-pack-client'
import { ImportFromUrlClient } from './import-from-url-client'

export const metadata: Metadata = { title: 'Marketplace — Harmoven' }

const SOURCE_LABEL: Record<string, string> = {
  official: 'Official',
  git:      'Git',
  local:    'Local',
}

export default async function MarketplacePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin      = instanceRole === 'instance_admin'

  // Show installed packs (all source types) ordered by recency
  const installed = await db.mcpSkill.findMany({
    orderBy: { installed_at: 'desc' },
    select: {
      id:          true,
      name:        true,
      source_type: true,
      version:     true,
      enabled:     true,
      scan_status: true,
      installed_at: true,
    },
  })

  return (
    <div className="space-y-8 animate-stagger">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Marketplace</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Domain packs extend Harmoven with industry-specific agent profiles and tools.
          </p>
        </div>
      </div>

      {/* Install form — admin only */}
      {isAdmin && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Install a pack</h2>
          <InstallPackClient />
        </section>
      )}

      {/* Import from GitHub URL — admin only */}
      {isAdmin && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Import from GitHub URL</h2>
          <p className="text-xs text-muted-foreground -mt-1">
            Fetch a raw GitHub file and convert it to a pack. Human review required before activation.
          </p>
          <ImportFromUrlClient />
        </section>
      )}

      {/* Installed packs */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Installed packs
          <span className="ml-2 font-normal normal-case text-muted-foreground">
            ({installed.filter((p) => p.enabled).length} enabled / {installed.length} total)
          </span>
        </h2>

        {installed.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <ShoppingBag className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No packs installed yet.</p>
              {isAdmin && (
                <p className="text-xs text-muted-foreground">
                  Use the form above to install a pack from the official registry or a Git URL.
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
                            <span>Installed {new Date(pack.installed_at).toLocaleDateString('en')}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pack.enabled ? (
                      <Badge variant="completed">enabled</Badge>
                    ) : (
                      <Badge variant="pending">disabled</Badge>
                    )}
                    {pack.scan_status === 'failed' && (
                      <Badge variant="failed">scan failed</Badge>
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
