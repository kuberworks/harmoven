'use client'

// components/run/DagView.tsx
// Visual DAG renderer for a Harmoven run.
//
// Renders the DAG from `run.dag` (nodes + edges) as an SVG-based graph using
// a topological-level layout (BFS from roots). Each node shows its agent type,
// ID, and live status overlay. Clicking a node opens a detail panel on the right.
// Edges are drawn as cubic Bezier curves.

import React, { useMemo, useState, useCallback } from 'react'
import type { Dag, DagNode, DagEdge } from '@/types/dag.types'
import { X, RotateCcw } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodeStatusOverlay {
  status:          string
  cost_usd?:       number
  error?:          string
  tokens_in?:      number
  tokens_out?:     number
  started_at?:     string | null
  completed_at?:   string | null
  llm_profile_id?: string | null
  partial_output?: string | null
  handoff_out?:    unknown
}

interface DagViewProps {
  dag:             Dag
  nodeStates:      Record<string, NodeStatusOverlay>
  onRestartNode?:  (nodeId: string) => void
  className?:      string
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W   = 130
const NODE_H   = 44
const H_GAP    = 72   // horizontal gap between columns
const V_GAP    = 12   // vertical gap between nodes in the same column
const PAD      = 16   // canvas padding

// ─── Status colours ───────────────────────────────────────────────────────────

const STATUS_FILL: Record<string, string> = {
  PENDING:   'var(--surface-raised)',
  RUNNING:   'var(--node-bg-running)',
  COMPLETED: 'var(--node-bg-completed)',
  FAILED:    'var(--node-bg-failed)',
  SKIPPED:   'var(--surface-raised)',
}

const STATUS_STROKE: Record<string, string> = {
  PENDING:   'var(--color-status-pending)',
  RUNNING:   'var(--color-status-running)',
  COMPLETED: 'var(--color-status-completed)',
  FAILED:    'var(--color-status-failed)',
  SKIPPED:   'var(--color-status-pending)',
}

const STATUS_TEXT: Record<string, string> = {
  PENDING:   'var(--text-secondary)',
  RUNNING:   'var(--node-text-running)',
  COMPLETED: 'var(--node-text-completed)',
  FAILED:    'var(--node-text-failed)',
  SKIPPED:   'var(--text-disabled)',
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

// ─── Detail panel ─────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  PENDING:   'bg-gray-700/50 text-gray-400',
  RUNNING:   'bg-blue-900/60 text-blue-300',
  COMPLETED: 'bg-emerald-900/60 text-emerald-300',
  FAILED:    'bg-red-900/60 text-red-300',
  SKIPPED:   'bg-gray-700/50 text-gray-500',
}

function DetailPanel({
  dagNode,
  state,
  edges,
  allNodes,
  onClose,
  onRestart,
  restarting,
}: {
  dagNode:    DagNode
  state:      NodeStatusOverlay | undefined
  edges:      DagEdge[]
  allNodes:   DagNode[]
  onClose:    () => void
  onRestart?: (nodeId: string) => void
  restarting: Set<string>
}) {
  const status = state?.status ?? 'PENDING'
  const badgeCls = STATUS_BADGE[status] ?? STATUS_BADGE.PENDING!

  // Dependencies
  const upstreams   = edges.filter(e => e.to === dagNode.id).map(e => allNodes.find(n => n.id === e.from)).filter(Boolean) as DagNode[]
  const downstreams = edges.filter(e => e.from === dagNode.id).map(e => allNodes.find(n => n.id === e.to)).filter(Boolean) as DagNode[]

  // Duration
  const durationMs = state?.started_at && state?.completed_at
    ? new Date(state.completed_at).getTime() - new Date(state.started_at).getTime()
    : null
  const duration = durationMs === null
    ? (state?.started_at && !state?.completed_at ? 'running…' : '—')
    : durationMs < 1000
    ? '<1s'
    : durationMs < 60_000
    ? `${Math.round(durationMs / 1000)}s`
    : `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`

  // Output content from handoff_out
  const handoff = (state?.handoff_out as Record<string, unknown> | null) ?? null
  const outputObj = handoff?.['output'] as Record<string, unknown> | null | undefined
  const outputContent = (outputObj?.['content'] ?? outputObj?.['summary']) as string | undefined

  const canRestart = !!onRestart && (status === 'FAILED' || status === 'INTERRUPTED' || status === 'COMPLETED')

  return (
    <div className="w-72 shrink-0 flex flex-col overflow-hidden border-l border-border bg-card text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-foreground truncate">{dagNode.agent_type}</span>
          <span className="font-mono text-xs text-muted-foreground">{dagNode.id}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${badgeCls}`}>{status}</span>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 ml-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Metrics */}
        {status !== 'PENDING' && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Metrics</p>
            <div className="rounded-lg overflow-hidden divide-y divide-border border border-border">
              {[
                ['Model',      state?.llm_profile_id ?? '—',  false],
                ['Tokens in',  state?.tokens_in  != null ? state.tokens_in.toLocaleString('en')  : '—', true],
                ['Tokens out', state?.tokens_out != null ? state.tokens_out.toLocaleString('en') : '—', true],
                ['Cost',       state?.cost_usd != null && state.cost_usd > 0 ? `€${state.cost_usd.toFixed(4)}` : '—', true],
                ['Duration',   duration, false],
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between px-3 py-1.5 text-xs">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-mono text-foreground text-right max-w-[140px] truncate" title={v as string}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Dependencies */}
        {(upstreams.length > 0 || downstreams.length > 0) && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Dependencies</p>
            <div className="flex gap-6 flex-wrap text-xs">
              {upstreams.length > 0 && (
                <div>
                  <p className="text-muted-foreground mb-1">After</p>
                  {upstreams.map(n => (
                    <div key={n.id} className="flex items-center gap-1.5 text-foreground mb-1">
                      <span className="font-mono">{n.id}</span>
                      <span className="text-muted-foreground">{n.agent_type}</span>
                    </div>
                  ))}
                </div>
              )}
              {downstreams.length > 0 && (
                <div>
                  <p className="text-muted-foreground mb-1">Feeds into</p>
                  {downstreams.map(n => (
                    <div key={n.id} className="flex items-center gap-1.5 text-foreground mb-1">
                      <span className="font-mono">{n.id}</span>
                      <span className="text-muted-foreground">{n.agent_type}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {state?.error && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-red-400 mb-2">Error</p>
            <pre className="text-xs text-red-300 bg-red-950/30 border border-red-900/40 rounded-lg p-3 whitespace-pre-wrap break-words line-clamp-6 font-mono">
              {state.error}
            </pre>
          </div>
        )}

        {/* Partial output (RUNNING) */}
        {status === 'RUNNING' && state?.partial_output && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-blue-400 mb-2">Partial output</p>
            <pre className="text-xs text-muted-foreground bg-card border border-border rounded-lg p-3 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono">
              {state.partial_output.slice(-600)}
            </pre>
          </div>
        )}

        {/* Output (COMPLETED) */}
        {outputContent && status !== 'RUNNING' && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-emerald-400 mb-2">Output</p>
            <pre className="text-xs text-muted-foreground bg-card border border-border rounded-lg p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-mono">
              {outputContent.length > 1200 ? outputContent.slice(0, 1200) + '\n…' : outputContent}
            </pre>
          </div>
        )}

        {/* Restart / Re-run */}
        {canRestart && (
          <button
            onClick={() => onRestart!(dagNode.id)}
            disabled={restarting.has(dagNode.id)}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-600/40 bg-amber-950/30 px-3 py-2 text-xs font-medium text-amber-300 hover:bg-amber-950/50 transition-colors disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            {restarting.has(dagNode.id)
              ? 'Restarting…'
              : status === 'COMPLETED' ? 'Re-run agent' : 'Restart agent'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── DagView ──────────────────────────────────────────────────────────────────

export function DagView({ dag, nodeStates, onRestartNode, className }: DagViewProps) {
  const { nodes: dagNodes, edges } = dag
  const [restarting, setRestarting] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const handleSelect = useCallback((nodeId: string) => {
    setSelectedId(prev => prev === nodeId ? null : nodeId)
  }, [])

  const handleRestart = (nodeId: string) => {
    if (!onRestartNode || restarting.has(nodeId)) return
    setRestarting(prev => new Set([...prev, nodeId]))
    try {
      onRestartNode(nodeId)
    } finally {
      setTimeout(() => setRestarting(prev => { const s = new Set(prev); s.delete(nodeId); return s }), 3000)
    }
  }

  // Stable topology key — re-run layout only when DAG structure changes, not when
  // the dag/edges array references change (which happens on every RUN SSE event
  // even if the topology is unchanged).
  const dagTopologyKey = dagNodes.map(n => n.id).join(',')
  const edgesTopologyKey = edges.map(e => `${e.from}-${e.to}`).join(',')
  const layouted = useMemo(
    () => layoutNodes(dagNodes, edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dagTopologyKey, edgesTopologyKey],
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
    <div className={`flex rounded-lg border border-surface-border bg-surface-1 overflow-hidden ${className ?? ''}`}>
      {/* SVG canvas */}
      <div className="overflow-x-auto p-3 flex-1 min-w-0">
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
          const isSelected = selectedId === n.id

          return (
            <g
              key={n.id}
              transform={`translate(${n.x}, ${n.y})`}
              onClick={() => handleSelect(n.id)}
              style={{ cursor: 'pointer' }}
              role="button"
              aria-label={`${n.type} ${n.id} — ${status}`}
              aria-pressed={isSelected}
            >
              {/* Selected highlight ring */}
              {isSelected && (
                <rect
                  x={-2} y={-2}
                  width={NODE_W + 4} height={NODE_H + 4}
                  rx={8} ry={8}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  opacity={0.8}
                />
              )}

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

              {/* Restart overlay — shown on FAILED or INTERRUPTED nodes when onRestartNode is provided */}
              {onRestartNode && (status === 'FAILED' || status === 'INTERRUPTED') && (
                <g
                  onClick={(ev) => { ev.stopPropagation(); handleRestart(n.id) }}
                  style={{ cursor: restarting.has(n.id) ? 'wait' : 'pointer' }}
                  role="button"
                  aria-label={`Restart ${n.type} (${n.id})`}
                >
                  {/* Semi-transparent overlay */}
                  <rect
                    x={0} y={NODE_H - 16}
                    width={NODE_W} height={16}
                    rx={0} ry={0}
                    fill={restarting.has(n.id) ? '#78350f' : '#451a03'}
                    opacity={0.92}
                  />
                  <rect
                    x={0} y={NODE_H - 16}
                    width={NODE_W} height={16}
                    rx={0} ry={0}
                    fill="none"
                    stroke="#d97706"
                    strokeWidth={0.5}
                    opacity={0.5}
                  />
                  <text
                    x={NODE_W / 2} y={NODE_H - 5}
                    textAnchor="middle"
                    fontSize={8.5}
                    fontWeight="600"
                    fill="#fbbf24"
                    fontFamily="system-ui, sans-serif"
                    letterSpacing="0.05em"
                  >
                    {restarting.has(n.id) ? '…' : '↺ Restart'}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </svg>
      </div>

      {/* Detail panel */}
      {selectedId && (() => {
        const dagNode = dagNodes.find(n => n.id === selectedId)
        if (!dagNode) return null
        // Optimistically clear error when a restart is in-flight so the user
        // doesn't keep seeing the stale error message before the SSE event arrives.
        const rawState = nodeStates[selectedId]
        const state = restarting.has(selectedId) && rawState
          ? { ...rawState, error: undefined }
          : rawState
        return (
          <DetailPanel
            dagNode={dagNode}
            state={state}
            edges={edges}
            allNodes={dagNodes}
            onClose={() => setSelectedId(null)}
            onRestart={onRestartNode}
            restarting={restarting}
          />
        )
      })()}
    </div>
  )
}
