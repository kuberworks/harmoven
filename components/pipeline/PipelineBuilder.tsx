'use client'
// components/pipeline/PipelineBuilder.tsx
// Full-featured pipeline DAG editor built on React Flow (@xyflow/react).
// Supports: drag-from-palette, connect nodes, delete (Delete/Backspace key),
//           save (named template), load from template.

import { useCallback, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type OnConnect,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { AgentNode, type AgentNodeData, type AgentType } from './AgentNode'
import { NodePalette } from './NodePalette'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Dag, DagNode, DagEdge } from '@/types/dag.types'

// ─── Node types registry ──────────────────────────────────────────────────────

const NODE_TYPES = { agentNode: AgentNode }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dagToFlow(dag: Dag): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = dag.nodes.map((n, i) => ({
    id:       n.id,
    type:     'agentNode',
    position: { x: 80 + (i % 3) * 220, y: 80 + Math.floor(i / 3) * 160 },
    data:     { agent_type: n.agent_type as AgentType, config: n.config } satisfies AgentNodeData,
  }))

  const edges: Edge[] = dag.edges.map((e, i) => ({
    id:     `e-${e.from}-${e.to}-${i}`,
    source: e.from,
    target: e.to,
    animated: false,
  }))

  return { nodes, edges }
}

function flowToDag(nodes: Node[], edges: Edge[]): Dag {
  const dagNodes: DagNode[] = nodes.map((n) => ({
    id:         n.id,
    agent_type: (n.data as AgentNodeData).agent_type,
    config:     (n.data as AgentNodeData).config,
  }))

  const dagEdges: DagEdge[] = edges.map((e) => ({
    from: e.source,
    to:   e.target,
  }))

  return { nodes: dagNodes, edges: dagEdges }
}

let nodeCounter = 0
function nextNodeId() { return `n${++nodeCounter}` }

// ─── Props ────────────────────────────────────────────────────────────────────

interface PipelineBuilderProps {
  initialDag?:     Dag
  templateName?:   string
  templateId?:     string   // set when editing an existing template
  projectId?:      string
  onSaved?:        (template: { id: string; name: string; dag: Dag }) => void
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PipelineBuilder({
  initialDag,
  templateName = '',
  templateId,
  projectId,
  onSaved,
}: PipelineBuilderProps) {
  const init = initialDag ? dagToFlow(initialDag) : { nodes: [], edges: [] }

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(init.nodes)
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(init.edges)
  const [name, setName]           = useState(templateName)
  const [saving, setSaving]       = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const reactFlowWrapper          = useRef<HTMLDivElement>(null)

  // ── Connect two nodes ──────────────────────────────────────────────────────
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => setRfEdges((eds) => addEdge(connection, eds)),
    [setRfEdges],
  )

  // ── Drop agent from palette ────────────────────────────────────────────────
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const agentType = event.dataTransfer.getData('application/reactflow-agent-type') as AgentType
      if (!agentType) return

      const bounds = reactFlowWrapper.current?.getBoundingClientRect()
      if (!bounds) return

      const position = {
        x: event.clientX - bounds.left - 70,
        y: event.clientY - bounds.top  - 40,
      }

      const id   = nextNodeId()
      const node: Node = {
        id,
        type:     'agentNode',
        position,
        data:     { agent_type: agentType } satisfies AgentNodeData,
      }
      setRfNodes((nds) => [...nds, node])
    },
    [setRfNodes],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  // ── Save / update template ────────────────────────────────────────────────
  async function handleSave() {
    if (!name.trim()) { setSaveError('Template name is required'); return }
    setSaving(true)
    setSaveError(null)

    const dag = flowToDag(rfNodes, rfEdges)
    const isUpdate = Boolean(templateId)
    const url  = isUpdate ? `/api/pipeline-templates/${templateId}` : '/api/pipeline-templates'
    const method = isUpdate ? 'PUT' : 'POST'

    const body: Record<string, unknown> = { name, dag }
    if (projectId) body.project_id = projectId

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setSaveError((err as { error?: string }).error ?? `HTTP ${res.status}`)
        return
      }

      const data = await res.json() as { template: { id: string; name: string } }
      onSaved?.({ id: data.template.id, name: data.template.name, dag })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full gap-0">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2 bg-background shrink-0">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pipeline template name…"
          className="h-8 w-64 text-sm"
        />
        {saveError && <span className="text-sm text-destructive">{saveError}</span>}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setRfNodes([]); setRfEdges([]) }}
          >
            Clear
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : templateId ? 'Update template' : 'Save template'}
          </Button>
        </div>
      </div>

      {/* Builder area */}
      <div className="flex flex-1 min-h-0">
        <NodePalette />
        <div ref={reactFlowWrapper} className="flex-1" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            deleteKeyCode={['Delete', 'Backspace']}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls />
            <MiniMap nodeColor={() => '#f59e0b'} maskColor="rgba(0,0,0,0.06)" />
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}
