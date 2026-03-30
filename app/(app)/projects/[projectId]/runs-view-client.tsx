'use client'

// app/(app)/projects/[projectId]/runs-view-client.tsx
// Runs section of the project overview — Kanban (default) / List toggle.
// Persists view preference in localStorage per-key "harmoven:runs-view".
// Kanban SSE-live via RunsKanbanClient; list view is a static compact table.

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { KanbanSquare, List, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { RunsKanbanClient } from './runs/runs-kanban-client'
import type { RunSummary } from './runs/runs-kanban-client'
import { cn } from '@/lib/utils/cn'

const STORAGE_KEY = 'harmoven:runs-view'

const STATUS_VARIANT: Record<string, 'running' | 'completed' | 'failed' | 'paused' | 'pending' | 'suspended'> = {
  RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed',
  PAUSED: 'paused', PENDING: 'pending', SUSPENDED: 'suspended',
}

interface Props {
  projectId: string
  runs: RunSummary[]
}

export function RunsViewClient({ projectId, runs }: Props) {
  const [view, setView] = useState<'kanban' | 'list'>('kanban')
  const [mounted, setMounted] = useState(false)

  // Hydrate preference from localStorage after mount (avoid SSR mismatch)
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'list' || saved === 'kanban') setView(saved)
    setMounted(true)
  }, [])

  function switchView(v: 'kanban' | 'list') {
    setView(v)
    localStorage.setItem(STORAGE_KEY, v)
  }

  if (!mounted) return null  // avoid flash of wrong view during hydration

  return (
    <div className="space-y-3">
      {/* Toggle */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {runs.length} run{runs.length !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center rounded-md border border-surface-border bg-surface-hover p-0.5 gap-0.5">
          <button
            type="button"
            onClick={() => switchView('kanban')}
            title="Kanban view"
            aria-pressed={view === 'kanban'}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors duration-150',
              view === 'kanban'
                ? 'bg-surface-raised text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <KanbanSquare className="h-3.5 w-3.5" />
            Kanban
          </button>
          <button
            type="button"
            onClick={() => switchView('list')}
            title="List view"
            aria-pressed={view === 'list'}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors duration-150',
              view === 'list'
                ? 'bg-surface-raised text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <List className="h-3.5 w-3.5" />
            List
          </button>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-10">No runs yet.</p>
      ) : view === 'kanban' ? (
        <RunsKanbanClient projectId={projectId} initialRuns={runs} />
      ) : (
        /* ── List view ─────────────────────────────────────────────────────── */
        <div className="flex flex-col divide-y divide-surface-border rounded-card border border-surface-border overflow-hidden">
          {runs.map((run) => (
            <Link
              key={run.id}
              href={`/projects/${projectId}/runs/${run.id}`}
              className="flex items-center justify-between gap-4 px-4 py-3 bg-surface-raised hover:bg-surface-hover transition-colors group"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Badge variant={STATUS_VARIANT[run.status] ?? 'pending'}>
                  {run.status}
                </Badge>
                <span className="text-sm font-medium text-foreground truncate max-w-[260px]">
                  {run.task_input
                    ? run.task_input.slice(0, 60) + (run.task_input.length > 60 ? '…' : '')
                    : <span className="font-mono text-muted-foreground">{run.id.slice(0, 8)}</span>}
                </span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {run.user?.name && (
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {run.user.name}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(run.created_at).toLocaleDateString('en', {
                    month: 'short', day: 'numeric',
                  })}
                </span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* View all link */}
      <div className="text-center pt-1">
        <Link
          href={`/projects/${projectId}/runs`}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          View all runs →
        </Link>
      </div>
    </div>
  )
}
