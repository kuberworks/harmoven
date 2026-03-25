// lib/agents/planner.ts
// Planner — decomposes a task into an executable DAG of agent sub-tasks.
// Spec: AGENTS-01-CORE.md Sections 4 and 5.2.
//
// Rules:
// - Always uses the highest-capability LLM tier ("powerful").
// - meta.confidence < 85 → requires_human_approval = true (UI checkpoint shown).
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/mock-client'
import type { ClassifierResult, ProfileId } from '@/lib/agents/classifier'

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
- Max lateral delegations: 2.`

// ─── Planner ─────────────────────────────────────────────────────────────────

export class Planner {
  constructor(private readonly llm: ILLMClient) {}

  async plan(
    task_input: string,
    profile: ClassifierResult,
    run_id: string,
  ): Promise<PlannerHandoff> {
    const result = await this.llm.chat(
      [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            task: task_input,
            domain_profile: profile.detected_profile,
            run_id,
          }),
        },
      ],
      { model: 'powerful' },
    )

    let parsed: unknown
    try {
      parsed = JSON.parse(result.content)
    } catch {
      throw new Error(
        `Planner: LLM returned invalid JSON — ${result.content.slice(0, 200)}`,
      )
    }

    const raw = parsed as Record<string, unknown>
    const meta = raw['meta'] as Record<string, unknown> | undefined
    if (typeof meta?.['confidence'] !== 'number') {
      throw new Error('Planner: missing or invalid "meta.confidence" field in LLM response')
    }

    return {
      ...(raw as Omit<PlannerHandoff, 'requires_human_approval'>),
      requires_human_approval: (meta['confidence'] as number) < 85,
    }
  }
}
