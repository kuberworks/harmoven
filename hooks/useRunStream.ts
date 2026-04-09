'use client'
// hooks/useRunStream.ts
// SSE reconnect hook for live run state streaming.
// Pattern per SKILLS.md §1 — EventSource + reducer + Last-Event-ID replay.

import { useEffect, useReducer, useRef, useCallback } from 'react'
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
  handoff_out: unknown
}

type StreamEvent =
  | { type: 'initial'; run: RunState; nodes: NodeState[] }
  | { type: 'state_change'; entity_type: 'run' | 'node'; id: string; status: string }
  | { type: 'node_snapshot'; node_id: string; data: Partial<NodeState> & Record<string, unknown> }
  | { type: 'nodes_refresh'; nodes: NodeState[]; dag?: Dag }
  | { type: 'cost_update'; cost_usd: number; tokens: number; percent_of_budget: number }
  | { type: 'human_gate'; gate_id: string; reason: string; data: Record<string, unknown> }
  | { type: 'budget_warning'; percent_used: number; remaining_usd: number }
  | { type: 'completed'; run: RunState; handoff_note: string }
  | { type: 'run_finished'; status: string }
  | { type: 'error'; node_id: string; message: string }
  | { type: 'artifacts_ready'; node_id: string; artifact_count: number; filenames: string[] }
  | { type: 'artifact_ready'; artifact_id: string; filename: string; mime_type: string; node_id: string; artifact_role: 'pending_review' | 'primary' | 'supplementary' }
  | { type: 'tool_call_progress'; node_id: string; tool_name: string; iteration: number; query?: string; result_count?: number; is_error: boolean }
  | { type: 'spawned_followup_runs'; node_id: string; runs: Array<{ run_id: string; label: string }> }

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
      } else if (e.type === 'nodes_refresh') {
        // PLANNER expanded the DAG — replace the full node list and update the dag
        nodes = e.nodes
        if (e.dag && run) run = { ...run, dag: e.dag }
      } else if (e.type === 'state_change') {
        if (e.entity_type === 'run' && run) {
          run = { ...run, status: e.status as RunStatus }
        } else if (e.entity_type === 'node') {
          // The SSE sends node_id (e.g. "n3"), not the DB UUID id.
          // Match on either field for robustness.
          nodes = nodes.map(n =>
            (n.id === e.id || n.node_id === e.id)
              ? e.status === 'PENDING'
                ? { ...n, status: 'PENDING' as NodeStatus, error: null, handoff_out: null, partial_output: null, started_at: null, completed_at: null }
                : { ...n, status: e.status as NodeStatus, error: n.error }
              : n,
          )
        }
      } else if (e.type === 'node_snapshot') {
        nodes = nodes.map(n =>
          n.node_id === e.node_id
            ? { ...n, ...e.data } as NodeState
            : n,
        )
      } else if (e.type === 'error') {
        // Mark the node as FAILED and set its error message in the live state
        nodes = nodes.map(n =>
          n.node_id === e.node_id
            ? { ...n, status: 'FAILED' as NodeStatus, error: e.message }
            : n,
        )
      } else if (e.type === 'cost_update' && run) {
        run = { ...run, cost_actual_usd: e.cost_usd, tokens_actual: e.tokens }
      } else if (e.type === 'completed' && run) {
        run = { ...e.run }
      } else if (e.type === 'run_finished' && run) {
        // run_finished carries the terminal/suspended status — keeps run.status in sync
        // when the stream doesn't receive a matching state_change (e.g. SUSPENDED on gate open).
        run = { ...run, status: e.status as RunStatus }
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
  const reconnectFnRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!runId) return

    let es: EventSource
    let reconnectTimer: ReturnType<typeof setTimeout>
    let destroyed = false
    let attempt = 0
    // Set to true when a `completed` event is received.
    // Prevents onerror from triggering a reconnect+RESET cascade when the browser
    // fires onerror after a client-side es.close() (Firefox does this).
    // The cascade causes `stream.run` to reset to null, the UI to fall back to
    // `initialRun` (RUNNING), and the 'result' tab to disappear while the user
    // is looking at it (because the tab is conditionally rendered on COMPLETED).
    let completedClean = false

    function connect() {
      if (destroyed) return
      // Reset completedClean on every new connection attempt.
      // Without this, after a run completes (completedClean=true + es.close()), any
      // subsequent reconnect() call (e.g. node replay, re-review) creates a new
      // EventSource but inherits completedClean=true. If that new EventSource gets
      // ANY onerror (HMR, brief network hiccup, browser quirk), onerror silently
      // returns without reconnecting, the stream dies permanently, and live SSE
      // events (including state_change(SUSPENDED) for human gates) never reach
      // the client — so the Human review required banner never appears.
      completedClean = false
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
          // Stop reconnecting once run reaches a terminal state with no chance of restart.
          // Keep listening on FAILED — a user may restart a failed node, which pushes
          // new state_change events that need to reach the client.
          if (payload.type === 'completed') {
            completedClean = true
            es.close()
          }
        } catch { /* malformed SSE frame — skip */ }
      }

      es.onerror = () => {
        // If we intentionally closed after `completed`, ignore the onerror that
        // Firefox (and occasionally other browsers) fire on es.close() — we don't
        // want to trigger RESET + reconnect for a cleanly finished run.
        if (completedClean) return
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

    reconnectFnRef.current = () => {
      clearTimeout(reconnectTimer)
      es?.close()
      // Reset lastEventId so the stream replays from the beginning on reconnect
      lastEventIdRef.current = null
      connect()
    }

    connect()

    return () => {
      destroyed = true
      reconnectFnRef.current = null
      clearTimeout(reconnectTimer)
      es?.close()
    }
  }, [runId])

  const reconnect = useCallback(() => {
    reconnectFnRef.current?.()
  }, [])

  return { ...state, reconnect }
}
