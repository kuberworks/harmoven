// app/(app)/marketplace/[id]/page.tsx
// PipelineTemplate detail page.
// Visible to all authenticated users; public templates are global, project-scoped ones need project access.

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Package, Globe, Lock, ArrowLeft, Hash, Calendar } from 'lucide-react'

export const metadata: Metadata = { title: 'Template · Marketplace' }

interface Props {
  params: Promise<{ id: string }>
}

export default async function TemplateDetailPage({ params }: Props) {
  const { id } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const tpl = await db.pipelineTemplate.findUnique({
    where: { id },
    select: {
      id:          true,
      name:        true,
      description: true,
      is_public:   true,
      use_count:   true,
      created_at:  true,
      updated_at:  true,
      project_id:  true,
      created_by:  true,
      dag:         true,
      creator: { select: { name: true, email: true } },
    },
  })

  if (!tpl) notFound()

  const instanceRole = (session.user as Record<string, unknown>).role as string | null
  const isAdmin = instanceRole === 'instance_admin'

  // Project-scoped templates — check membership
  if (tpl.project_id) {
    const membership = await db.projectMember.findFirst({
      where: { project_id: tpl.project_id, user_id: session.user.id },
    })
    if (!membership && !isAdmin) redirect('/marketplace')
  }

  const dag = tpl.dag as { nodes?: unknown[]; edges?: unknown[] } | null
  const nodeCount = dag?.nodes?.length ?? 0
  const edgeCount = dag?.edges?.length ?? 0

  return (
    <div className="space-y-6 animate-stagger max-w-2xl">
      {/* Back */}
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground" asChild>
        <Link href="/marketplace">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to marketplace
        </Link>
      </Button>

      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-surface-border bg-surface-card p-2 shrink-0">
          <Package className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold text-foreground">{tpl.name}</h1>
            {tpl.is_public ? (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Globe className="h-3 w-3" /> Public
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-xs">
                <Lock className="h-3 w-3" /> Project
              </Badge>
            )}
          </div>
          {tpl.description && (
            <p className="text-sm text-muted-foreground mt-1">{tpl.description}</p>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Uses',     value: tpl.use_count.toLocaleString('en'), icon: Hash },
          { label: 'Nodes',    value: nodeCount.toString(),                icon: Package },
          { label: 'Created',  value: new Date(tpl.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }), icon: Calendar },
          { label: 'Updated',  value: new Date(tpl.updated_at).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }), icon: Calendar },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
              <p className="text-lg font-semibold text-foreground">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Creator */}
      {tpl.creator && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Author</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium text-foreground">{tpl.creator.name ?? tpl.creator.email}</p>
          </CardContent>
        </Card>
      )}

      {/* DAG summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Pipeline structure</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-foreground">
            {nodeCount} node{nodeCount !== 1 ? 's' : ''}, {edgeCount} edge{edgeCount !== 1 ? 's' : ''}
          </p>
          {nodeCount === 0 && (
            <p className="text-xs text-muted-foreground mt-1">No DAG data available.</p>
          )}
        </CardContent>
      </Card>

      {/* Use / Load button */}
      <div>
        <Button asChild>
          <Link href={`/pipelines/new?template=${tpl.id}`}>Use this template</Link>
        </Button>
      </div>
    </div>
  )
}
