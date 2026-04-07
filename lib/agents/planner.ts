// lib/agents/planner.ts
// Planner — decomposes a task into an executable DAG of agent sub-tasks.
// Spec: AGENTS-01-CORE.md Sections 4 and 5.2.
//
// Rules:
// - Always uses the highest-capability LLM tier ("powerful").
// - meta.confidence < 85 → requires_human_approval = true (UI checkpoint shown).
// - Full ClassifierResult context passed to LLM (not just profile id).
// - DAG validated: acyclicity, node id refs, single REVIEWER as last node.
// - Cost estimates clamped to $0–$999.
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/interface'
import type { ClassifierResult, ProfileId } from '@/lib/agents/classifier'
import { withRetry } from '@/lib/utils/retry'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlannerNode {
  node_id: string
  /** Agent role. WRITER executes leaf tasks; REVIEWER is always the final node. */
  agent: 'WRITER' | 'REVIEWER' | 'QA' | 'DEVOPS'
  description: string
  /** node_ids that must reach COMPLETED before this node can start. */
  dependencies: string[]
  llm_strategy: 'dynamic' | 'fast' | 'balanced' | 'powerful'
  complexity: 'low' | 'medium' | 'high'
  timeout_minutes: number
  /** References to outputs of prior nodes, e.g. "output:n1". */
  inputs: string[]
  expected_output_type: string
}

export interface PlannerEdge {
  from: string
  to: string
}

export interface PlannerMeta {
  /** 0–100. Below 85 → requires_human_approval. */
  confidence: number
  confidence_rationale: string
  estimated_total_tokens: number
  estimated_cost_usd: number
  estimated_duration_minutes: number
  /** Groups of node_ids that can run in parallel. */
  parallel_branches: string[][]
  human_gate_points: string[]
}

export interface PlannerHandoff {
  handoff_version: string
  source_agent: 'PLANNER'
  target_agent: 'DAG_EXECUTOR'
  run_id: string
  domain_profile: ProfileId
  task_summary: string
  assumptions: string[]
  dag: {
    nodes: PlannerNode[]
    edges: PlannerEdge[]
  }
  meta: PlannerMeta
  /** Derived: true when meta.confidence < 85 → UI shows approval checkpoint. */
  requires_human_approval: boolean
}

// ─── System prompt ────────────────────────────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `\
You are the Harmoven Planner. Decompose the given task into an executable DAG of agent sub-tasks.
Output ONLY valid JSON matching this schema — no markdown, no prose:

{
  "handoff_version": "1.0",
  "source_agent": "PLANNER",
  "target_agent": "DAG_EXECUTOR",
  "run_id": "<run_id from input>",
  "domain_profile": "<profile id>",
  "task_summary": "<one sentence task summary>",
  "assumptions": ["<assumption 1>"],
  "dag": {
    "nodes": [
      {
        "node_id": "n1",
        "agent": "WRITER",
        "description": "<what this node produces>",
        "dependencies": [],
        "llm_strategy": "dynamic",
        "complexity": "high",
        "timeout_minutes": 20,
        "inputs": [],
        "expected_output_type": "code"
      }
    ],
    "edges": [
      {"from": "n1", "to": "n2"}
    ]
  },
  "meta": {
    "confidence": <integer 0-100>,
    "confidence_rationale": "<brief explanation>",
    "estimated_total_tokens": <integer>,
    "estimated_cost_usd": <float>,
    "estimated_duration_minutes": <integer>,
    "parallel_branches": [],
    "human_gate_points": ["after_reviewer"]
  }
}

Rules:
- Use WRITER for all content/code generation nodes.
- REVIEWER must be the final node (depends on all other leaf nodes).
- dependencies contains node_ids that must complete first.
- If meta.confidence < 85, the plan will require human approval before execution.
- Max lateral delegations: 2.
- CRITICAL: Maximum DAG depth is 4 levels. The longest chain of sequential nodes (longest path from any root node to REVIEWER) must not exceed 4 nodes. Use parallel branches (siblings with the same dependency) to scale width, not depth.`

// ─── DAG validation ───────────────────────────────────────────────────────────

function validateDag(dag: PlannerHandoff['dag']): void {
  const nodeIds = new Set(dag.nodes.map(n => n.node_id))

  // All edge endpoints must reference known nodes
  for (const edge of dag.edges) {
    if (!nodeIds.has(edge.from)) throw new Error(`Planner: edge references unknown node "${edge.from}"`)
    if (!nodeIds.has(edge.to))   throw new Error(`Planner: edge references unknown node "${edge.to}"`)
  }

  // All dependency refs must reference known nodes
  for (const node of dag.nodes) {
    for (const dep of node.dependencies) {
      if (!nodeIds.has(dep)) throw new Error(`Planner: node "${node.node_id}" depends on unknown "${dep}"`)
    }
  }

  // Cycle detection via Kahn's algorithm
  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const id of nodeIds) { inDegree.set(id, 0); adj.set(id, []) }
  for (const edge of dag.edges) {
    adj.get(edge.from)!.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }
  const queue = [...nodeIds].filter(id => inDegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const curr = queue.shift()!
    visited++
    for (const next of adj.get(curr) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }
  if (visited !== nodeIds.size) throw new Error('Planner: DAG contains a cycle')

  // Exactly one REVIEWER node must exist and have no successors
  const reviewerNodes = dag.nodes.filter(n => n.agent === 'REVIEWER')
  if (reviewerNodes.length === 0) throw new Error('Planner: DAG must contain exactly one REVIEWER node')
  if (reviewerNodes.length > 1)  throw new Error('Planner: DAG contains more than one REVIEWER node')
  const reviewerNode = reviewerNodes[0]
  if (!reviewerNode) throw new Error('Planner: DAG must contain exactly one REVIEWER node')
  const reviewerId = reviewerNode.node_id
  const hasSuccessor = dag.edges.some(e => e.from === reviewerId)
  if (hasSuccessor) throw new Error('Planner: REVIEWER node must be the final node (no outgoing edges)')

  // Depth check: longest path must not exceed 4 levels (spec §lib/dag/validate.ts).
  // Recompute in-degree from scratch (the Kahn queue above is already consumed).
  const MAX_DAG_DEPTH = 4
  const depthInDeg = new Map<string, number>()
  const depthAdj  = new Map<string, string[]>()
  for (const id of nodeIds) { depthInDeg.set(id, 0); depthAdj.set(id, []) }
  for (const edge of dag.edges) {
    depthAdj.get(edge.from)!.push(edge.to)
    depthInDeg.set(edge.to, (depthInDeg.get(edge.to) ?? 0) + 1)
  }
  // BFS from all roots, tracking depth of each node.
  const depth = new Map<string, number>()
  const depthQueue = [...nodeIds].filter(id => depthInDeg.get(id) === 0)
  for (const root of depthQueue) depth.set(root, 0)
  const bfsQueue = [...depthQueue]
  while (bfsQueue.length > 0) {
    const curr = bfsQueue.shift()!
    const currDepth = depth.get(curr) ?? 0
    for (const next of depthAdj.get(curr) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 0, currDepth + 1)
      depth.set(next, nextDepth)
      bfsQueue.push(next)
    }
  }
  const maxDepth = Math.max(0, ...[...depth.values()])
  if (maxDepth > MAX_DAG_DEPTH) {
    throw new Error(`Planner: DAG depth ${maxDepth} exceeds maximum allowed depth of ${MAX_DAG_DEPTH}`)
  }
}

// ─── Planner exhaustion error ────────────────────────────────────────────────

/**
 * Thrown when the Planner fails validation 3 times in a row.
 * The caller (executor) should open a HumanGate instead of failing the run.
 */
export class PlannerExhaustionError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(
      `Planner: DAG validation failed after ${attempts} attempt${
        attempts === 1 ? '' : 's'
      } — opening human gate for operator review`,
    )
    this.name = 'PlannerExhaustionError'
  }
}

// ─── Planner ─────────────────────────────────────────────────────────────────

export class Planner {
  constructor(private readonly llm: ILLMClient) {}

  async plan(
    task_input: string,
    profile: ClassifierResult,
    run_id: string,
    signal?: AbortSignal,
  ): Promise<PlannerHandoff> {
    // Outer loop: retry the full LLM + validation cycle up to 3 times on
    // *validation* failures. withRetry() inside already handles LLM-level
    // transient errors (network, rate-limit, 5xx) without counting them here.
    // Spec: "Planner retry: max 3 re-runs on validation failure → Human Gate"
    const MAX_VALIDATION_ATTEMPTS = 3
    let lastErr: unknown

    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
      try {
        const result = await withRetry(
          () => this.llm.chat(
            [
              { role: 'system', content: PLANNER_SYSTEM_PROMPT },
              {
                role: 'user',
                content: JSON.stringify({
                  task: task_input,
                  run_id,
                  // Full classifier context — not just profile id
                  classifier: {
                    domain_profile:          profile.detected_profile,
                    domain:                  profile.domain,
                    output_type:             profile.output_type,
                    confidence:              profile.confidence,
                    input_summary:           profile.input_summary,
                    clarification_questions: profile.clarification_questions,
                  },
                }),
              },
            ],
            { model: 'powerful', signal },
          ),
          {
            signal,
            onRetry: (err, llmAttempt) =>
              console.warn(`[Planner] LLM attempt ${llmAttempt} failed (validation attempt ${attempt}):`, err),
          },
        )

        let parsed: unknown
        const content = result.content ?? ''
        try {
          let raw = content
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```\s*$/, '')
            .trim()
          try {
            parsed = JSON.parse(raw)
          } catch {
            const match = raw.match(/\{[\s\S]*\}/)
            if (!match || match[0] == null) throw new Error('no JSON object found in response')
            parsed = JSON.parse(match[0])
          }
        } catch {
          throw new Error(
            `Planner: LLM returned invalid JSON — ${content.slice(0, 300)}`,
          )
        }

        const raw = parsed as Record<string, unknown>
        const meta = raw['meta'] as Record<string, unknown> | undefined
        if (typeof meta?.['confidence'] !== 'number') {
          throw new Error('Planner: missing or invalid "meta.confidence" field in LLM response')
        }

        const confidence = meta['confidence'] as number
        if (confidence < 0 || confidence > 100) {
          throw new Error('Planner: meta.confidence must be 0–100')
        }

        // Clamp cost estimate to sane range ($0–$999)
        if (typeof meta['estimated_cost_usd'] === 'number') {
          meta['estimated_cost_usd'] = Math.min(Math.max(0, meta['estimated_cost_usd']), 999)
        }

        const dag = raw['dag'] as PlannerHandoff['dag']
        validateDag(dag)

        return {
          ...(raw as Omit<PlannerHandoff, 'requires_human_approval'>),
          requires_human_approval: confidence < 85,
        }
      } catch (err) {
        // Never retry on abort — it's an intentional cancellation.
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        lastErr = err
        console.warn(
          `[Planner] validation attempt ${attempt}/${MAX_VALIDATION_ATTEMPTS} failed:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    // All validation attempts exhausted — escalate to human gate.
    throw new PlannerExhaustionError(MAX_VALIDATION_ATTEMPTS, lastErr)
  }
}
