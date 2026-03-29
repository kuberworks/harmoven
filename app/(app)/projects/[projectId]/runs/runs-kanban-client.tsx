'use client'

// app/(app)/projects/[projectId]/runs/runs-kanban-client.tsx
// Kanban board — columns by run status.
// Client component: re-orders runs as SSE events arrive (project-level stream).
// Uses project-level EventSource (/api/projects/:id/stream).

import { useEffect, useReducer } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { RUN_STATUS_VARIANT } from '@/lib/utils/run-status'
import type { RunStatus } from '@/types/run.types'

export interface RunSummary {
  id: string
  status: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  paused_at: string | null
  cost_actual_usd: number
  tokens_actual: number
  user: { name: string } | null
}

interface Props {
  projectId: string
  initialRuns: RunSummary[]
}

const COLUMNS: { status: RunStatus; label: string }[] = [
  { status: 'PENDING',   label: 'Pending' },
  { status: 'RUNNING',   label: 'Running' },
  { status: 'PAUSED',    label: 'Paused' },
  { status: 'SUSPENDED', label: 'Suspended' },
  { status: 'COMPLETED', label: 'Completed' },
  { status: 'FAILED',    label: 'Failed' },
]

const STATUS_VARIANT = RUN_STATUS_VARIANT

// Simple reducer: update run status after SSE state_change events
function runsReducer(runs: RunSummary[], action: { runId: string; status: string }): RunSummary[] {
  return runs.map((r) => r.id === action.runId ? { ...r, status: action.status } : r)
}

function RunCard({ run, projectId }: { run: RunSummary; projectId: string }) {
  const elapsed = run.started_at
    ? Math.round((Date.now() - new Date(run.started_at).getTime()) / 60_000)
    : null

  return (
    <Link href={`/projects/${projectId}/runs/${run.id}`} className="group outline-none">
      <Card className="mb-2 transition-colors group-hover:border-accent-amber group-focus-visible:ring-2 group-focus-visible:ring-amber-500">
        <CardContent className="p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-mono text-muted-foreground truncate">
              {run.id.slice(0, 8)}
            </span>
            <Badge variant={STATUS_VARIANT[run.status] ?? 'pending'}>
              {run.status}
            </Badge>
          </div>
          {run.user?.name && (
            <p className="text-xs text-muted-foreground">by {run.user.name}</p>
          )}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            {elapsed !== null ? (
              <span>{elapsed}m</span>
            ) : (
              <span>{new Date(run.created_at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</span>
            )}
            {run.cost_actual_usd > 0 && (
              <span className="font-mono">€{run.cost_actual_usd.toFixed(3)}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

export function RunsKanbanClient({ projectId, initialRuns }: Props) {
  const [runs, dispatch] = useReducer(runsReducer, initialRuns)

  // Subscribe to project-level SSE for live status updates
  useEffect(() => {
    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/stream`)

    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data) as {
          type: string
          entity_type?: string
          id?: string
          status?: string
        }
        if (payload.type === 'state_change' && payload.entity_type === 'run' && payload.id && payload.status) {
          dispatch({ runId: payload.id, status: payload.status })
        }
      } catch { /* skip malformed */ }
    }

    return () => es.close()
  }, [projectId])

  // Show only columns that have runs, plus always RUNNING
  const activeStatuses = new Set(runs.map((r) => r.status))
  const visibleColumns = COLUMNS.filter(
    (col) => activeStatuses.has(col.status) || col.status === 'RUNNING',
  )

  return (
    <div className="overflow-x-auto pb-4">
      <div className="flex gap-4 min-w-max">
        {visibleColumns.map(({ status, label }) => {
          const colRuns = runs.filter((r) => r.status === status)
          return (
            <div key={status} className="w-64 shrink-0">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {label}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">{colRuns.length}</span>
              </div>
              <div className="min-h-[120px] rounded-card border border-surface-border bg-surface-raised/50 p-2">
                {colRuns.length === 0 ? (
                  <p className="text-xs text-muted-foreground/50 text-center py-8">Empty</p>
                ) : (
                  colRuns.map((run) => (
                    <RunCard key={run.id} run={run} projectId={projectId} />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
