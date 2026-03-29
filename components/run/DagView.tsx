'use client'

// components/run/DagView.tsx
// Visual DAG renderer for a Harmoven run.
//
// Renders the DAG from `run.dag` (nodes + edges) as an SVG-based graph using
// a topological-level layout (BFS from roots). Each node shows its agent type,
// ID, and live status overlay. Edges are drawn as cubic Bezier curves.
//
// Props:
//   dag        — static DAG structure (DagNode[], DagEdge[])
//   nodeStates — live status map keyed by node_id
//
// Layout:
//   Columns = topological levels (left → right).
//   Within a column, nodes are stacked top-to-bottom, centered vertically.
//   Edges connect right-centre of source to left-centre of target.

import React, { useMemo } from 'react'
import type { Dag, DagNode, DagEdge } from '@/types/dag.types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodeStatusOverlay {
  status:   string
  cost_usd?: number
  error?:   string
}

interface DagViewProps {
  dag:        Dag
  nodeStates: Record<string, NodeStatusOverlay>
  className?: string
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W   = 130
const NODE_H   = 44
const H_GAP    = 72   // horizontal gap between columns
const V_GAP    = 12   // vertical gap between nodes in the same column
const PAD      = 16   // canvas padding

// ─── Status colours ───────────────────────────────────────────────────────────

const STATUS_FILL: Record<string, string> = {
  PENDING:   'var(--surface-raised, #1e1e2a)',
  RUNNING:   'var(--color-blue-950, #172554)',
  COMPLETED: 'var(--color-emerald-950, #022c22)',
  FAILED:    'var(--color-red-950,  #290101)',
  SKIPPED:   'var(--surface-raised, #1e1e2a)',
}

const STATUS_STROKE: Record<string, string> = {
  PENDING:   'var(--surface-border, #374151)',
  RUNNING:   '#3b82f6',
  COMPLETED: '#10b981',
  FAILED:    '#ef4444',
  SKIPPED:   'var(--surface-border, #374151)',
}

const STATUS_TEXT: Record<string, string> = {
  PENDING:   '#6b7280',
  RUNNING:   '#93c5fd',
  COMPLETED: '#6ee7b7',
  FAILED:    '#fca5a5',
  SKIPPED:   '#4b5563',
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

/** Compute topological levels (BFS from roots). Returns Map<nodeId → level>. */
function computeLevels(nodes: DagNode[], edges: DagEdge[]): Map<string, number> {
  const inDegree   = new Map<string, number>(nodes.map(n => [n.id, 0]))
  const successors = new Map<string, string[]>(nodes.map(n => [n.id, []]))

  for (const e of edges) {
    inDegree.set(e.to,   (inDegree.get(e.to)   ?? 0) + 1)
    successors.get(e.from)?.push(e.to)
  }

  const level  = new Map<string, number>()
  const queue: string[] = []

  for (const [id, deg] of inDegree) {
    if (deg === 0) { queue.push(id); level.set(id, 0) }
  }

  while (queue.length > 0) {
    const id  = queue.shift()!
    const lvl = level.get(id) ?? 0
    for (const next of successors.get(id) ?? []) {
      const nextLevel = Math.max(level.get(next) ?? 0, lvl + 1)
      level.set(next, nextLevel)
      inDegree.set(next, (inDegree.get(next) ?? 1) - 1)
      if ((inDegree.get(next) ?? 0) <= 0) queue.push(next)
    }
  }

  // Any unreached node (cycle guard) → put at level 0
  for (const n of nodes) {
    if (!level.has(n.id)) level.set(n.id, 0)
  }

  return level
}

interface LayoutNode {
  id:     string
  type:   string
  level:  number
  x:      number
  y:      number
}

/** Assign x/y pixel positions to nodes based on their topological level. */
function layoutNodes(nodes: DagNode[], edges: DagEdge[]): LayoutNode[] {
  if (nodes.length === 0) return []

  const levels     = computeLevels(nodes, edges)
  const byLevel    = new Map<number, DagNode[]>()
  let   maxLevel   = 0

  for (const n of nodes) {
    const lv = levels.get(n.id) ?? 0
    if (!byLevel.has(lv)) byLevel.set(lv, [])
    byLevel.get(lv)!.push(n)
    if (lv > maxLevel) maxLevel = lv
  }

  // Sort nodes within each level by id for stable rendering
  for (const [, arr] of byLevel) arr.sort((a, b) => a.id.localeCompare(b.id))

  const maxNodesInLevel = Math.max(...[...byLevel.values()].map(a => a.length))
  const totalHeight = maxNodesInLevel * NODE_H + (maxNodesInLevel - 1) * V_GAP

  const result: LayoutNode[] = []

  for (const [lv, arr] of byLevel) {
    const colHeight = arr.length * NODE_H + (arr.length - 1) * V_GAP
    const startY    = PAD + (totalHeight - colHeight) / 2

    arr.forEach((n, i) => {
      result.push({
        id:    n.id,
        type:  n.agent_type,
        level: lv,
        x:     PAD + lv * (NODE_W + H_GAP),
        y:     startY + i * (NODE_H + V_GAP),
      })
    })
  }

  return result
}

// ─── DagView ──────────────────────────────────────────────────────────────────

export function DagView({ dag, nodeStates, className }: DagViewProps) {
  const { nodes: dagNodes, edges } = dag

  const layouted = useMemo(
    () => layoutNodes(dagNodes, edges),
    [dagNodes, edges],
  )

  const nodeById = useMemo(
    () => new Map(layouted.map(n => [n.id, n])),
    [layouted],
  )

  if (layouted.length === 0) {
    return (
      <div className={`flex items-center justify-center py-10 text-sm text-muted-foreground ${className ?? ''}`}>
        No DAG nodes yet.
      </div>
    )
  }

  const maxLevel    = Math.max(...layouted.map(n => n.level))
  const maxY        = Math.max(...layouted.map(n => n.y + NODE_H))
  const svgWidth    = PAD + (maxLevel + 1) * (NODE_W + H_GAP) - H_GAP + PAD
  const svgHeight   = maxY + PAD

  return (
    <div className={`overflow-x-auto rounded-lg border border-surface-border bg-surface-1 p-3 ${className ?? ''}`}>
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        aria-label="DAG run visualization"
        role="img"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="7"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" fill="var(--surface-border,#374151)" />
          </marker>
        </defs>

        {/* ── Edges ─────────────────────────────────────────────────────── */}
        {edges.map((e, i) => {
          const src = nodeById.get(e.from)
          const tgt = nodeById.get(e.to)
          if (!src || !tgt) return null

          const x1 = src.x + NODE_W
          const y1 = src.y + NODE_H / 2
          const x2 = tgt.x
          const y2 = tgt.y + NODE_H / 2
          const cpX = (x1 + x2) / 2

          return (
            <path
              key={i}
              d={`M${x1},${y1} C${cpX},${y1} ${cpX},${y2} ${x2},${y2}`}
              stroke="var(--surface-border,#374151)"
              strokeWidth={1.5}
              fill="none"
              markerEnd="url(#arrowhead)"
            />
          )
        })}

        {/* ── Nodes ─────────────────────────────────────────────────────── */}
        {layouted.map((n) => {
          const state  = nodeStates[n.id]
          const status = state?.status ?? 'PENDING'
          const fill   = STATUS_FILL[status]   ?? STATUS_FILL.PENDING!
          const stroke = STATUS_STROKE[status] ?? STATUS_STROKE.PENDING!
          const textC  = STATUS_TEXT[status]   ?? STATUS_TEXT.PENDING!
          const isRunning = status === 'RUNNING'

          return (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
              {/* Running pulse ring */}
              {isRunning && (
                <rect
                  x={-3} y={-3}
                  width={NODE_W + 6} height={NODE_H + 6}
                  rx={9} ry={9}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  opacity={0.6}
                >
                  <animate
                    attributeName="stroke-dashoffset"
                    from="0" to="18"
                    dur="1s"
                    repeatCount="indefinite"
                  />
                </rect>
              )}

              {/* Node rectangle */}
              <rect
                width={NODE_W} height={NODE_H}
                rx={6} ry={6}
                fill={fill}
                stroke={stroke}
                strokeWidth={isRunning ? 2 : 1}
              />

              {/* Agent type */}
              <text
                x={NODE_W / 2} y={16}
                textAnchor="middle"
                fontSize={11}
                fontWeight="600"
                fill={textC}
                fontFamily="system-ui, sans-serif"
              >
                {n.type.length > 14 ? n.type.slice(0, 13) + '…' : n.type}
              </text>

              {/* Node ID */}
              <text
                x={NODE_W / 2} y={28}
                textAnchor="middle"
                fontSize={9}
                fill={textC}
                opacity={0.7}
                fontFamily="ui-monospace, monospace"
              >
                {n.id}
              </text>

              {/* Status pill */}
              <rect
                x={(NODE_W - 64) / 2} y={33}
                width={64} height={9}
                rx={4} ry={4}
                fill={stroke}
                opacity={0.2}
              />
              <text
                x={NODE_W / 2} y={40}
                textAnchor="middle"
                fontSize={7.5}
                fontWeight="600"
                fill={stroke}
                fontFamily="system-ui, sans-serif"
                letterSpacing="0.04em"
              >
                {status}
              </text>

              {/* Cost badge (top-right corner) */}
              {state?.cost_usd !== undefined && state.cost_usd > 0 && (
                <text
                  x={NODE_W - 4} y={10}
                  textAnchor="end"
                  fontSize={7.5}
                  fill="#9ca3af"
                  fontFamily="ui-monospace, monospace"
                >
                  ${state.cost_usd < 0.01
                    ? state.cost_usd.toFixed(4)
                    : state.cost_usd.toFixed(2)}
                </text>
              )}

              {/* Error indicator (small red dot) */}
              {state?.error && (
                <circle cx={NODE_W - 5} cy={5} r={4} fill="#ef4444" />
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
