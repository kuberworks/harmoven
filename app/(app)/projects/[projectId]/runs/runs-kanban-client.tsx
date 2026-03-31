'use client'

// app/(app)/projects/[projectId]/runs/runs-kanban-client.tsx
// Kanban board — 4 columns matching harmoven_main_v5.html scr-runs design.
// Columns: Pending | Running | ⏸ Gate open (PAUSED+SUSPENDED) | Completed (incl. FAILED)
// Client component: re-orders runs as SSE events arrive (project-level stream).

import { useEffect, useReducer, useState } from 'react'
import Link from 'next/link'
import type { RunStatus } from '@/types/run.types'

// ─── Live elapsed clock ───────────────────────────────────────────────────────

/** Renders a self-updating elapsed time label. Re-renders once per second for RUNNING cards. */
function ElapsedTime({ startedAt }: { startedAt: string | null }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])

  if (!startedAt) return null
  const sec = Math.round((now - new Date(startedAt).getTime()) / 1000)
  const label = sec >= 60
    ? `${Math.floor(sec / 60)}m ${sec % 60}s`
    : `${sec}s`

  return <>{label}</>
}

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
  task_input: string | null
  has_open_gate: boolean
}

interface Props {
  projectId: string
  initialRuns: RunSummary[]
}

// ─── 4-column layout matching mockup scr-runs ─────────────────────────────────

type KanbanVarKey = 'pending' | 'running' | 'gate' | 'done'

type KanbanColumn = {
  key: string
  label: string
  statuses: string[]
  /** CSS variable prefix — matches --kc-{varKey}-{bg|text|count} in globals.css */
  varKey: KanbanVarKey
}

const COLUMNS: KanbanColumn[] = [
  {
    key: 'pending',
    label: 'Pending',
    statuses: ['PENDING'],
    varKey: 'pending',
  },
  {
    key: 'running',
    label: 'Running',
    statuses: ['RUNNING'],
    varKey: 'running',
  },
  {
    key: 'gate',
    label: '⏸ Gate open',
    statuses: ['PAUSED', 'SUSPENDED'],
    varKey: 'gate',
  },
  {
    key: 'done',
    label: 'Completed',
    statuses: ['COMPLETED', 'FAILED'],
    varKey: 'done',
  },
]

// ─── Card left-border & icon per status ──────────────────────────────────────

function cardAccent(status: string): string {
  switch (status) {
    case 'RUNNING':   return 'border-l-blue-500/70 bg-gradient-to-r from-blue-500/5 to-transparent'
    case 'PAUSED':
    case 'SUSPENDED': return 'border-l-amber-500/70 bg-gradient-to-r from-amber-500/5 to-transparent'
    case 'COMPLETED': return 'border-l-emerald-500/50'
    case 'FAILED':    return 'border-l-red-500/70 bg-gradient-to-r from-red-500/5 to-transparent'
    default:          return 'border-l-muted-foreground/20'
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'COMPLETED': return '✓'
    case 'FAILED':    return '✕'
    case 'PAUSED':
    case 'SUSPENDED': return '⏸'
    default:          return ''
  }
}

function statusIconColor(status: string): string {
  switch (status) {
    case 'COMPLETED': return 'text-emerald-400'
    case 'FAILED':    return 'text-red-400'
    case 'PAUSED':
    case 'SUSPENDED': return 'text-amber-400'
    default:          return ''
  }
}

// ─── Run card ────────────────────────────────────────────────────────────────

function RunCard({ run, projectId }: { run: RunSummary; projectId: string }) {
  const isRunning          = run.status === 'RUNNING'
  const isGate             = run.status === 'PAUSED' || run.status === 'SUSPENDED'
  const isGateReview       = isGate && run.has_open_gate      // real human gate open
  const isGateRecovering   = run.status === 'SUSPENDED' && !run.has_open_gate  // crash recovery
  const isFailed           = run.status === 'FAILED'

  const icon = statusIcon(run.status)
  const iconColor = statusIconColor(run.status)

  return (
    <Link
      href={`/projects/${projectId}/runs/${run.id}`}
      className={`block rounded-card border border-surface-border border-l-[3px] p-3 mb-2 transition-colors hover:border-surface-hover cursor-pointer ${cardAccent(run.status)}`}
    >
      {/* Title row */}
      <div className="flex items-start gap-1.5 mb-0.5">
        {icon && <span className={`text-[11px] mt-0.5 shrink-0 ${iconColor}`}>{icon}</span>}
        <span className="text-[13px] font-semibold text-foreground leading-snug line-clamp-2">
          {run.task_input ? run.task_input.slice(0, 60) + (run.task_input.length > 60 ? '…' : '') : '—'}
        </span>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground/50 mb-1 pl-[calc(1.5ch+1px)]">
        {run.id.slice(0, 8)}
      </div>

      {/* Meta */}
      <div className="text-[11px] text-muted-foreground mb-2">
        {run.user?.name ? `${run.user.name} · ` : ''}
        {isRunning ? <ElapsedTime startedAt={run.started_at} /> : null}
        {!isRunning && run.created_at
          ? new Date(run.created_at).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : ''}
        {run.cost_actual_usd > 0 ? ` · €${run.cost_actual_usd.toFixed(3)}` : ''}
      </div>

      {/* Progress bar for RUNNING */}
      {isRunning && (
        <div className="h-[5px] rounded-full bg-surface-border overflow-hidden">
          <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 rounded-full animate-pulse w-[60%]" />
        </div>
      )}

      {/* Gate badge — only when a real HumanGate is open */}
      {isGateReview && (
        <div className="mt-1.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono border border-amber-500/30 bg-amber-500/10 text-amber-400">
            awaiting review
          </span>
        </div>
      )}

      {/* Recovering badge — crash-suspended, no gate open */}
      {isGateRecovering && (
        <div className="mt-1.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono border border-blue-500/30 bg-blue-500/10 text-blue-400">
            ⟳ interrupted
          </span>
        </div>
      )}

      {/* Paused badge — manual pause, no gate */}
      {run.status === 'PAUSED' && !run.has_open_gate && (
        <div className="mt-1.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono border border-amber-500/30 bg-amber-500/10 text-amber-400">
            paused
          </span>
        </div>
      )}

      {/* Failed badge */}
      {isFailed && (
        <div className="mt-1.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono border border-red-500/30 bg-red-500/10 text-red-400">
            failed
          </span>
        </div>
      )}

      {/* Gate CTA — only when a real HumanGate is open */}
      {isGateReview && (
        <button
          type="button"
          className="mt-2 w-full text-center text-[11px] font-semibold rounded-md border border-amber-500/40 text-amber-400 py-1 hover:bg-amber-500/10 transition-colors"
          onClick={(e) => { e.preventDefault(); window.location.href = `/projects/${projectId}/runs/${run.id}/gate` }}
        >
          Review now →
        </button>
      )}
    </Link>
  )
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

function runsReducer(runs: RunSummary[], action: { runId: string; status: string }): RunSummary[] {
  return runs.map((r) => r.id === action.runId ? { ...r, status: action.status } : r)
}

// ─── Kanban board ─────────────────────────────────────────────────────────────

export function RunsKanbanClient({ projectId, initialRuns }: Props) {
  const [runs, dispatch] = useReducer(runsReducer, initialRuns)

  useEffect(() => {
    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/stream`)
    es.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data) as {
          type: string; entity_type?: string; id?: string; status?: string
        }
        if (payload.type === 'state_change' && payload.entity_type === 'run' && payload.id && payload.status) {
          dispatch({ runId: payload.id, status: payload.status })
        }
      } catch { /* skip */ }
    }
    return () => es.close()
  }, [projectId])

  return (
    <div className="overflow-x-auto pb-4 -mx-1">
      <div className="flex gap-3 min-w-max px-1">
        {COLUMNS.map((col) => {
          const colRuns = runs.filter((r) => col.statuses.includes(r.status))
          return (
            <div key={col.key} className="w-[240px] shrink-0 flex flex-col gap-2">
              {/* Column header */}
              <div
                className="flex items-center justify-between px-2.5 py-2 rounded-md mb-0.5"
                style={{
                  background: `var(--kc-${col.varKey}-bg)`,
                  color: `var(--kc-${col.varKey}-text)`,
                }}
              >
                <span className="text-[11px] font-medium uppercase tracking-[0.07em]">{col.label}</span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-mono"
                  style={{ background: `var(--kc-${col.varKey}-count)` }}
                >
                  {colRuns.length}
                </span>
              </div>

              {/* Cards */}
              <div className="min-h-[100px]">
                {colRuns.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground/40 text-center py-8">Empty</p>
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


