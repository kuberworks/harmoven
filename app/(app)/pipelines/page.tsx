// app/(app)/pipelines/page.tsx
// Pipeline templates list — Server Component.
// Shows the user's own templates + public global templates.

import type { Metadata } from 'next'
import { headers }       from 'next/headers'
import Link              from 'next/link'
import { redirect }      from 'next/navigation'
import { auth }          from '@/lib/auth'
import { listTemplates } from '@/lib/pipeline/templates'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button }        from '@/components/ui/button'
import { Badge }         from '@/components/ui/badge'
import { Workflow, Plus, Sparkles } from 'lucide-react'

export const metadata: Metadata = { title: 'Pipelines' }

export default async function PipelinesPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/login')

  const templates = await listTemplates({ user_id: session.user.id })

  return (
    <div className="space-y-6 animate-stagger">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Pipeline Templates</h1>
          <p className="text-sm text-muted-foreground">
            Reusable DAG definitions for your agent pipelines
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/pipelines/new">
            <Plus className="h-4 w-4" />
            New template
          </Link>
        </Button>
      </div>

      {/* List */}
      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <Workflow className="h-10 w-10 text-muted-foreground/50" />
            <div>
              <p className="font-medium text-foreground">No pipeline templates yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Build a custom pipeline and save it as a reusable template.
              </p>
            </div>
            <Button asChild size="sm">
              <Link href="/pipelines/new">
                <Plus className="h-4 w-4" />
                New template
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(templates as Array<(typeof templates)[0]>).map((t) => (
            <Link key={t.id} href={`/pipelines/${t.id}`} className="group outline-none">
              <Card className="h-full transition-colors group-hover:border-accent-amber group-focus-visible:ring-2 group-focus-visible:ring-amber-500">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base font-semibold leading-tight line-clamp-2">
                      {t.name}
                    </CardTitle>
                    <div className="flex gap-1 shrink-0">
                      {t.is_public && (
                        <Badge variant="secondary" className="text-xs">Public</Badge>
                      )}
                      {t.ai_suggestion && (
                        <Badge className="text-xs bg-violet-500/15 text-violet-700 border-violet-500/40">
                          <Sparkles className="h-3 w-3 mr-1" />
                          AI suggestion
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {t.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                      {t.description}
                    </p>
                  )}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{t._count.runs} run{t._count.runs !== 1 ? 's' : ''}</span>
                    <span>{t._count.versions} version{t._count.versions !== 1 ? 's' : ''}</span>
                    <span>
                      {new Date(t.updated_at).toLocaleDateString('en', {
                        month: 'short', day: 'numeric',
                      })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
