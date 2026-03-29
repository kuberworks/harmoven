'use client'
// hooks/useRunStream.ts
// SSE reconnect hook for live run state streaming.
// Pattern per SKILLS.md §1 — EventSource + reducer + Last-Event-ID replay.

import { useEffect, useReducer, useRef } from 'react'
import type { RunStatus, NodeStatus } from '@/types/run.types'
import type { Dag } from '@/types/dag.types'

export interface RunState {
  id: string
  status: RunStatus
  cost_actual_usd: number
  tokens_actual: number
  paused_at: string | null
  started_at: string | null
  completed_at: string | null
  dag: Dag
}

export interface NodeState {
  id: string
  node_id: string
  agent_type: string
  status: NodeStatus
  cost_usd: number
  tokens_in: number
  tokens_out: number
  llm_profile_id: string | null
  started_at: string | null
  completed_at: string | null
  error: string | null
  partial_output: string | null
}

type StreamEvent =
  | { type: 'initial'; run: RunState; nodes: NodeState[] }
  | { type: 'state_change'; entity_type: 'run' | 'node'; id: string; status: string }
  | { type: 'cost_update'; cost_usd: number; tokens: number; percent_of_budget: number }
  | { type: 'human_gate'; gate_id: string; reason: string; data: Record<string, unknown> }
  | { type: 'budget_warning'; percent_used: number; remaining_usd: number }
  | { type: 'completed'; run: RunState; handoff_note: string }
  | { type: 'error'; node_id: string; message: string }

export interface StreamState {
  run: RunState | null
  nodes: NodeState[]
  events: StreamEvent[]
  connected: boolean
  error: string | null
}

type Action =
  | { type: 'CONNECTED' }
  | { type: 'EVENT'; payload: StreamEvent }
  | { type: 'ERROR' }
  | { type: 'RESET' }

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case 'CONNECTED':
      return { ...state, connected: true, error: null }
    case 'ERROR':
      return { ...state, connected: false, error: 'Connection lost — reconnecting…' }
    case 'RESET':
      return { run: null, nodes: [], events: [], connected: false, error: null }
    case 'EVENT': {
      const e = action.payload
      let { run, nodes } = state
      if (e.type === 'initial') {
        run = e.run
        nodes = e.nodes
      } else if (e.type === 'state_change') {
        if (e.entity_type === 'run' && run) {
          run = { ...run, status: e.status as RunStatus }
        } else if (e.entity_type === 'node') {
          nodes = nodes.map(n => n.id === e.id ? { ...n, status: e.status as NodeStatus } : n)
        }
      } else if (e.type === 'cost_update' && run) {
        run = { ...run, cost_actual_usd: e.cost_usd, tokens_actual: e.tokens }
      } else if (e.type === 'completed' && run) {
        run = { ...e.run }
      }
      return {
        ...state,
        run,
        nodes,
        events: [...state.events.slice(-100), e], // keep last 100 events in memory
      }
    }
    default:
      return state
  }
}

const INITIAL_STATE: StreamState = {
  run: null, nodes: [], events: [], connected: false, error: null,
}

export function useRunStream(runId: string) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const lastEventIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!runId) return

    let es: EventSource
    let reconnectTimer: ReturnType<typeof setTimeout>
    let destroyed = false
    let attempt = 0

    function connect() {
      if (destroyed) return
      dispatch({ type: 'RESET' })
      const url = `/api/runs/${encodeURIComponent(runId)}/stream`
        + (lastEventIdRef.current ? `?lastEventId=${lastEventIdRef.current}` : '')
      es = new EventSource(url)

      es.onopen = () => {
        attempt = 0 // reset backoff on successful connection
        dispatch({ type: 'CONNECTED' })
      }

      es.onmessage = (evt) => {
        try {
          if (evt.lastEventId) lastEventIdRef.current = evt.lastEventId
          const payload = JSON.parse(evt.data) as StreamEvent
          dispatch({ type: 'EVENT', payload })
          // Stop reconnecting once run reaches a terminal state
          if (
            payload.type === 'completed' ||
            (payload.type === 'state_change' &&
              payload.entity_type === 'run' &&
              ['COMPLETED', 'FAILED'].includes(payload.status))
          ) {
            es.close()
          }
        } catch { /* malformed SSE frame — skip */ }
      }

      es.onerror = () => {
        dispatch({ type: 'ERROR' })
        es.close()
        if (!destroyed) {
          // Exponential backoff with full jitter to avoid thundering herd
          // when many clients reconnect simultaneously after a server restart.
          // Formula: random(0, min(30_000, 500 * 2^attempt)) ms
          const cap = Math.min(30_000, 500 * Math.pow(2, attempt))
          const delay = Math.floor(Math.random() * cap)
          attempt++
          reconnectTimer = setTimeout(connect, delay)
        }
      }
    }

    connect()

    return () => {
      destroyed = true
      clearTimeout(reconnectTimer)
      es?.close()
    }
  }, [runId])

  return state
}
