'use client'

// components/task/TemplateGallery.tsx
// Domain pack templates gallery for run creation.
// Fetches from GET /api/pipeline-templates?project_id=:id

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils/cn'
import { Search, LayoutTemplate } from 'lucide-react'

interface Template {
  id: string
  name: string
  description: string | null
  is_public: boolean
  use_count: number
}

interface TemplateGalleryProps {
  projectId: string
  domainProfile?: string
  onSelect: (template: Template) => void
  selectedId?: string
}

export function TemplateGallery({ projectId, domainProfile, onSelect, selectedId }: TemplateGalleryProps) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(true)
  const [query, setQuery]         = useState('')

  useEffect(() => {
    const params = new URLSearchParams({ project_id: projectId })
    if (domainProfile) params.set('domain', domainProfile)

    fetch(`/api/pipeline-templates?${params}`)
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : (data.templates ?? [])
        setTemplates(list)
      })
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false))
  }, [projectId, domainProfile])

  const filtered = templates.filter(
    (t) => !query || t.name.toLowerCase().includes(query.toLowerCase()) ||
           (t.description ?? '').toLowerCase().includes(query.toLowerCase()),
  )

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
        <LayoutTemplate className="h-8 w-8 opacity-30" aria-hidden />
        <p className="text-sm">No templates available for this project.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates…"
          className="pl-8 h-8 text-sm"
          aria-label="Search templates"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No templates match your search.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t)}
              className={cn(
                'text-left rounded-xl border p-3 transition-all duration-150 ease-out',
                'hover:bg-surface-hover hover:border-amber-500/40',
                selectedId === t.id
                  ? 'border-amber-500/60 bg-amber-500/10'
                  : 'border-surface-border bg-surface-raised',
              )}
            >
              <div className="flex items-start justify-between gap-1">
                <p className="text-sm font-medium text-foreground line-clamp-1">{t.name}</p>
                {t.is_public && (
                  <Badge variant="secondary" className="text-xs shrink-0">public</Badge>
                )}
              </div>
              {t.description && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{t.description}</p>
              )}
              {t.use_count > 0 && (
                <p className="text-xs text-muted-foreground/60 mt-1.5">
                  Used {t.use_count} {t.use_count === 1 ? 'time' : 'times'}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
