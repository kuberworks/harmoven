'use client'
// components/pipeline/NodePalette.tsx
// Left sidebar listing draggable agent types for the pipeline builder.
// Drop onto the React Flow canvas to add a node.

import { AGENT_TYPES, type AgentType } from './AgentNode'

const AGENT_LABELS: Record<AgentType, string> = {
  CLASSIFIER:      'Classifier',
  PLANNER:         'Planner',
  WRITER:          'Writer',
  REVIEWER:        'Reviewer',
  SMOKE_TEST:      'Smoke Test',
  REPAIR:          'Repair',
  CRITICAL_REVIEW: 'Critical Review',
}

const AGENT_DESCRIPTIONS: Record<AgentType, string> = {
  CLASSIFIER:      'Classifies intent and routes the task',
  PLANNER:         'Builds the execution plan',
  WRITER:          'Generates the primary output',
  REVIEWER:        'Reviews and critiques output',
  SMOKE_TEST:      'Runs smoke tests on generated code',
  REPAIR:          'Fixes issues found by other agents',
  CRITICAL_REVIEW: 'Deep security and quality review',
}

export function NodePalette() {
  function onDragStart(event: React.DragEvent, agentType: AgentType) {
    event.dataTransfer.setData('application/reactflow-agent-type', agentType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <aside className="flex flex-col gap-2 w-52 shrink-0 p-3 border-r border-border bg-surface-raised overflow-y-auto">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">
        Agent types
      </p>
      {AGENT_TYPES.map((type) => (
        <div
          key={type}
          draggable
          onDragStart={(e) => onDragStart(e, type)}
          className="cursor-grab rounded-md border border-border bg-background px-3 py-2 shadow-sm
                     hover:border-accent-amber hover:shadow-md transition-all select-none"
        >
          <p className="text-xs font-semibold text-foreground">{AGENT_LABELS[type]}</p>
          <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
            {AGENT_DESCRIPTIONS[type]}
          </p>
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground mt-2">
        Drag an agent onto the canvas to add it to the pipeline.
      </p>
    </aside>
  )
}
