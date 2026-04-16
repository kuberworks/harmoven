'use client'
// app/(app)/pipelines/[id]/PipelineDetailClient.tsx
// Client shell for the pipeline detail page. Handles:
//   - Edit mode (PipelineBuilder)
//   - AI suggestion accept/dismiss
//   - Version history sidebar

import { useState } from 'react'
import { useRouter }            from 'next/navigation'
import { PipelineBuilder }      from '@/components/pipeline/PipelineBuilder'
import { Button }               from '@/components/ui/button'
import { Badge }                from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Sparkles, History, Pencil }  from 'lucide-react'
import type { Dag }             from '@/types/dag.types'

interface Version {
  id: string; version: number; change_note: string | null; source: string; created_at: Date
}

interface Template {
  id: string; name: string; description: string | null; dag: unknown
  ai_suggestion: unknown; ai_suggested_at: Date | null
  created_by: string | null; use_count: number; is_public: boolean
  versions: Version[]
  _count: { runs: number }
}

interface Props {
  template:      Template
  currentUserId: string
}

export function PipelineDetailClient({ template, currentUserId }: Props) {
  const router = useRouter()
  const [editing, setEditing]           = useState(false)
  const [accepting, setAccepting]       = useState(false)
  const [dismissing, setDismissing]     = useState(false)
  const hasSuggestion = Boolean(template.ai_suggestion)
  const canEdit = template.created_by === currentUserId

  async function handleAcceptSuggestion() {
    setAccepting(true)
    await fetch(`/api/pipeline-templates/${template.id}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept_suggestion: true }),
    })
    setAccepting(false)
    router.refresh()
  }

  async function handleDismiss() {
    setDismissing(true)
    // Dismiss by sending a minimal PUT that clears ai_suggestion server-side
    // (handled implicitly: a new user save clears the suggestion)
    await fetch(`/api/pipeline-templates/${template.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: template.name }), // no dag change, just a touch
    })
    setDismissing(false)
    router.refresh()
  }

  if (editing) {
    return (
      <div className="flex flex-col h-[calc(100vh-56px)]">
        <div className="flex items-center gap-3 border-b border-border px-6 py-3 bg-background shrink-0">
          <h1 className="text-lg font-semibold">{template.name}</h1>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
        <div className="flex-1 min-h-0">
          <PipelineBuilder
            initialDag={template.dag as Dag}
            templateName={template.name}
            templateId={template.id}
            onSaved={() => { setEditing(false); router.refresh() }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-stagger p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{template.name}</h1>
          {template.description && (
            <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
          )}
          <div className="flex gap-2 mt-2">
            <Badge variant="secondary">{template._count.runs} runs</Badge>
            <Badge variant="secondary">{template.versions.length} versions</Badge>
            {template.is_public && <Badge variant="secondary">Public</Badge>}
          </div>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing(true)}>
            <Pencil className="h-4 w-4" />
            Edit pipeline
          </Button>
        )}
      </div>

      {/* AI suggestion banner */}
      {hasSuggestion && (
        <Card className="border-violet-500/40 bg-violet-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              AI improvement suggestion available
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Based on recent run outcomes, the AI has proposed a change to this pipeline.
              Review the suggestion in edit mode, then accept or dismiss.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAcceptSuggestion} disabled={accepting}>
                {accepting ? 'Accepting…' : 'Accept suggestion'}
              </Button>
              <Button size="sm" variant="outline" onClick={handleDismiss} disabled={dismissing}>
                {dismissing ? 'Dismissing…' : 'Dismiss'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Version history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" />
            Version history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {template.versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions yet.</p>
          ) : (
            <ul className="space-y-2">
              {template.versions.map((v) => (
                <li key={v.id} className="flex items-center gap-3 text-sm">
                  <Badge variant="outline" className="shrink-0">v{v.version}</Badge>
                  <span className="text-muted-foreground flex-1 line-clamp-1">
                    {v.change_note ?? 'No note'}
                  </span>
                  {v.source === 'ai_suggestion' && (
                    <Badge className="text-[10px] bg-violet-500/15 text-violet-700 border-violet-500/40 shrink-0">
                      AI
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(v.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
