'use client'

// components/run/NodeCard.tsx
// Agent node status card — shown in Level 2+ run detail view.
// Displays: agent type, status badge, duration, cost (if showCost).

import { useState, useEffect } from 'react'
import { RunStatusBadge } from './RunStatusBadge'
import { CostMeter } from './CostMeter'
import { cn } from '@/lib/utils/cn'
import { Clock, Cpu } from 'lucide-react'

export interface NodeCardData {
  id: string
  node_id: string
  agent_type: string
  status: string
  started_at: string | null
  completed_at: string | null
  error: string | null
  cost_usd: number
  tokens_in: number
  tokens_out: number
}

interface NodeCardProps {
  node: NodeCardData
  showCost: boolean
  showTimings?: boolean
  onClick?: () => void
  selected?: boolean
}

function formatDuration(startMs: number, endMs: number): string {
  const sec = Math.round((endMs - startMs) / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

const AGENT_LABEL: Record<string, string> = {
  classifier:       'Classifier',
  planner:          'Planner',
  writer:           'Writer',
  reviewer:         'Reviewer',
  critical_reviewer:'Critical Reviewer',
  eval:             'Eval',
  handoff:          'Handoff',
}

export function NodeCard({ node, showCost, showTimings = true, onClick, selected }: NodeCardProps) {
  const label     = AGENT_LABEL[node.agent_type] ?? node.agent_type
  const totalCost = node.cost_usd ?? 0

  // duration is derived from Date.now() for running nodes — must be computed
  // client-side only to avoid SSR/hydration mismatch.
  const [duration, setDuration] = useState<string | null>(null)
  useEffect(() => {
    if (!showTimings || !node.started_at) {
      setDuration(null)
      return
    }
    const startMs = new Date(node.started_at).getTime()
    if (node.completed_at) {
      setDuration(formatDuration(startMs, new Date(node.completed_at).getTime()))
      return
    }
    // Node is still running — tick every second.
    setDuration(formatDuration(startMs, Date.now()))
    const id = setInterval(() => setDuration(formatDuration(startMs, Date.now())), 1000)
    return () => clearInterval(id)
  }, [showTimings, node.started_at, node.completed_at])

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-xl border px-3 py-2.5 transition-all duration-150 ease-out',
        'flex items-start justify-between gap-3',
        selected
          ? 'border-amber-500/60 bg-amber-500/10'
          : 'border-surface-border bg-surface-raised hover:bg-surface-hover hover:border-surface-border/80',
        onClick ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{label}</p>
          {node.error && (
            <p className="text-xs text-[var(--color-status-failed)] mt-0.5 truncate">{node.error}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {duration && showTimings && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
            <Clock className="h-3 w-3" aria-hidden />
            {duration}
          </span>
        )}
        <CostMeter costUsd={totalCost} showCosts={showCost} className="text-xs" />
        <RunStatusBadge status={node.status} animated />
      </div>
    </button>
  )
}
