'use client'
// components/pipeline/AgentNode.tsx
// Custom React Flow node representing a single agent in the DAG.
// Handles all 7 built-in agent types + visual state (selected, error).

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils/cn'

// ─── Agent metadata ───────────────────────────────────────────────────────────

export const AGENT_TYPES = [
  'CLASSIFIER',
  'PLANNER',
  'WRITER',
  'REVIEWER',
  'SMOKE_TEST',
  'REPAIR',
  'CRITICAL_REVIEW',
] as const

export type AgentType = (typeof AGENT_TYPES)[number]

const AGENT_META: Record<AgentType, { label: string; color: string; description: string }> = {
  CLASSIFIER:      { label: 'Classifier',      color: 'bg-blue-500/15 border-blue-500/40 text-blue-700 dark:text-blue-300',    description: 'Classifies intent and routes the task' },
  PLANNER:         { label: 'Planner',          color: 'bg-violet-500/15 border-violet-500/40 text-violet-700 dark:text-violet-300', description: 'Builds the execution plan' },
  WRITER:          { label: 'Writer',           color: 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300',  description: 'Generates the primary output' },
  REVIEWER:        { label: 'Reviewer',         color: 'bg-green-500/15 border-green-500/40 text-green-700 dark:text-green-300',  description: 'Reviews and critiques output' },
  SMOKE_TEST:      { label: 'Smoke Test',       color: 'bg-cyan-500/15 border-cyan-500/40 text-cyan-700 dark:text-cyan-300',     description: 'Runs smoke tests on generated code' },
  REPAIR:          { label: 'Repair',           color: 'bg-orange-500/15 border-orange-500/40 text-orange-700 dark:text-orange-300', description: 'Fixes issues found by other agents' },
  CRITICAL_REVIEW: { label: 'Critical Review',  color: 'bg-red-500/15 border-red-500/40 text-red-700 dark:text-red-300',        description: 'Deep security and quality review' },
}

// ─── Node data ────────────────────────────────────────────────────────────────

export interface AgentNodeData {
  agent_type: AgentType
  label?: string             // optional override
  config?: Record<string, unknown>
  [key: string]: unknown
}

// ─── Component ────────────────────────────────────────────────────────────────

function AgentNodeInner({ data, selected }: NodeProps) {
  const nodeData = data as AgentNodeData
  const meta = AGENT_META[nodeData.agent_type] ?? AGENT_META.WRITER

  return (
    <div
      className={cn(
        'relative rounded-lg border-2 bg-background px-4 py-3 shadow-sm transition-shadow min-w-[140px]',
        meta.color,
        selected && 'ring-2 ring-primary ring-offset-1',
      )}
    >
      {/* Input handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!h-3 !w-3 !border-2 !border-background !bg-current"
      />

      <div className="flex flex-col gap-1">
        <Badge variant="secondary" className="w-fit text-[10px] uppercase tracking-wide px-1.5 py-0">
          {nodeData.agent_type}
        </Badge>
        <span className="text-sm font-semibold leading-tight">
          {nodeData.label ?? meta.label}
        </span>
        <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
          {meta.description}
        </span>
      </div>

      {/* Output handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-3 !w-3 !border-2 !border-background !bg-current"
      />
    </div>
  )
}

export const AgentNode = memo(AgentNodeInner)
AgentNode.displayName = 'AgentNode'
