// app/(app)/marketplace/installed/page.tsx
// Lists all PipelineTemplates the current user has access to (public + project-scoped via membership).

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Package, Globe, Lock, ArrowRight, Hash } from 'lucide-react'

export const metadata: Metadata = { title: 'My templates · Marketplace' }

export default async function InstalledTemplatesPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin = instanceRole === 'instance_admin'

  // Collect project IDs this user is a member of
  const memberships = await db.projectMember.findMany({
    where: { user_id: session.user.id },
    select: { project_id: true },
  })
  const projectIds = memberships.map((m) => m.project_id)

  const templates = await db.pipelineTemplate.findMany({
    where: isAdmin
      ? {}
      : {
          OR: [
            { is_public: true, project_id: null },
            { project_id: { in: projectIds } },
            { created_by: session.user.id },
          ],
        },
    select: {
      id:          true,
      name:        true,
      description: true,
      is_public:   true,
      use_count:   true,
      created_at:  true,
      project_id:  true,
      project: { select: { name: true } },
    },
    orderBy: [{ use_count: 'desc' }, { created_at: 'desc' }],
    take: 100,
  })

  return (
    <div className="space-y-6 animate-stagger">
      <div>
        <h1 className="text-xl font-semibold text-foreground">My templates</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Public templates and those from your projects.
        </p>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Package className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No templates available yet.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/marketplace">Browse marketplace</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id} className="hover:border-primary/40 transition-colors">
              <CardContent className="pt-4 pb-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium text-foreground truncate">{t.name}</span>
                  </div>
                  {t.is_public ? (
                    <Badge variant="secondary" className="text-xs gap-1 shrink-0">
                      <Globe className="h-3 w-3" /> Public
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs gap-1 shrink-0">
                      <Lock className="h-3 w-3" /> {t.project?.name ?? 'Project'}
                    </Badge>
                  )}
                </div>
                {t.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{t.description}</p>
                )}
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Hash className="h-3 w-3" />
                    {t.use_count.toLocaleString('en')} uses
                  </span>
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" asChild>
                    <Link href={`/marketplace/${t.id}`}>
                      View <ArrowRight className="h-3 w-3" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
