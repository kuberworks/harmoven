// tests/agents/planner.test.ts
// Unit tests for Planner — 2 scenarios.
// Uses MockLLMClient — zero network / LLM cost.

import { Planner } from '@/lib/agents/planner'
import { MockLLMClient } from '@/lib/llm/mock-client'
import type { PlannerHandoff } from '@/lib/agents/planner'
import type { ClassifierResult } from '@/lib/agents/classifier'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** High-confidence classifier result for app_scaffolding. */
const appProfile: ClassifierResult = {
  classifier_version: '1.0',
  input_summary: 'User wants to build a restaurant reservation web app',
  detected_profile: 'app_scaffolding',
  output_type: 'code',
  domain: 'tech',
  confidence: 94,
  confidence_rationale: 'Strong app signals.',
  clarification_questions: [],
  fallback_profile: 'generic',
  user_confirmation_text: "It looks like you want to build an app.",
  requires_clarification: false,
}

/** Low-confidence generic classifier result. */
const genericProfile: ClassifierResult = {
  ...appProfile,
  detected_profile: 'generic',
  output_type: 'document',
  domain: 'generic',
  confidence: 55,
  user_confirmation_text: '',
  requires_clarification: true,
}

function makePlannerHandoff(overrides: Partial<PlannerHandoff> = {}): PlannerHandoff {
  const base: PlannerHandoff = {
    handoff_version: '1.0',
    source_agent: 'PLANNER',
    target_agent: 'DAG_EXECUTOR',
    run_id: 'run-test-001',
    domain_profile: 'app_scaffolding',
    task_summary: 'Build a restaurant reservation web app with table management',
    assumptions: [
      'Web app only (no mobile native)',
      'Default stack: Next.js + SQLite + Tailwind',
      'No payment integration required',
    ],
    dag: {
      nodes: [
        {
          node_id: 'n1',
          agent: 'WRITER',
          description: 'Scaffold Next.js project with auth and DB schema',
          dependencies: [],
          llm_strategy: 'dynamic',
          complexity: 'high',
          timeout_minutes: 20,
          inputs: [],
          expected_output_type: 'code',
        },
        {
          node_id: 'n2',
          agent: 'WRITER',
          description: 'Build reservation booking UI and API routes',
          dependencies: ['n1'],
          llm_strategy: 'dynamic',
          complexity: 'high',
          timeout_minutes: 25,
          inputs: ['output:n1'],
          expected_output_type: 'code',
        },
        {
          node_id: 'n3',
          agent: 'REVIEWER',
          description: 'Review all generated code for correctness and completeness',
          dependencies: ['n2'],
          llm_strategy: 'powerful',
          complexity: 'medium',
          timeout_minutes: 10,
          inputs: ['output:n1', 'output:n2'],
          expected_output_type: 'document',
        },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n2', to: 'n3' },
      ],
    },
    meta: {
      confidence: 88,
      confidence_rationale: 'Task well-scoped. Stack defaulted — no user preference given.',
      estimated_total_tokens: 120000,
      estimated_cost_usd: 0.95,
      estimated_duration_minutes: 55,
      parallel_branches: [],
      human_gate_points: ['after_reviewer'],
    },
    requires_human_approval: false,
  }

  return { ...base, ...overrides }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Planner', () => {
  it('produces a valid DAG for a well-scoped task (confidence ≥ 85)', async () => {
    const llm = new MockLLMClient()
    // Return handoff without the derived field — Planner computes it.
    const { requires_human_approval: _, ...handoffPayload } = makePlannerHandoff()
    llm.setNextResponse(JSON.stringify(handoffPayload))

    const planner = new Planner(llm)
    const result = await planner.plan(
      'Build a restaurant reservation app with table management',
      appProfile,
      'run-test-001',
    )

    // DAG structure
    expect(result.dag.nodes).toHaveLength(3)
    expect(result.dag.edges).toHaveLength(2)

    // First node has no dependencies
    expect(result.dag.nodes[0].node_id).toBe('n1')
    expect(result.dag.nodes[0].dependencies).toHaveLength(0)

    // Last node is REVIEWER
    const lastNode = result.dag.nodes[result.dag.nodes.length - 1]
    expect(lastNode.agent).toBe('REVIEWER')

    // Edge chain: n1 → n2, n2 → n3
    expect(result.dag.edges[0]).toEqual({ from: 'n1', to: 'n2' })
    expect(result.dag.edges[1]).toEqual({ from: 'n2', to: 'n3' })

    // High confidence → no human approval needed
    expect(result.meta.confidence).toBe(88)
    expect(result.requires_human_approval).toBe(false)

    // Planner must use the "powerful" LLM tier
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].options.model).toBe('powerful')

    // User task passed as user message content
    const userMsg = llm.calls[0].messages[1]
    expect(userMsg.role).toBe('user')
    expect(userMsg.content).toContain('restaurant reservation')
    expect(userMsg.content).toContain('app_scaffolding')
  })

  it('sets requires_human_approval when meta.confidence is below 85', async () => {
    const llm = new MockLLMClient()
    const { requires_human_approval: _, ...handoffPayload } = makePlannerHandoff({
      domain_profile: 'generic',
      task_summary: 'Vague task requiring human approval',
      assumptions: ['Domain unclear — defaulted to generic'],
      meta: {
        confidence: 70,
        confidence_rationale: 'Task scope is ambiguous. Domain defaulted to generic.',
        estimated_total_tokens: 40000,
        estimated_cost_usd: 0.25,
        estimated_duration_minutes: 20,
        parallel_branches: [],
        human_gate_points: ['before_execution', 'after_reviewer'],
      },
    })
    llm.setNextResponse(JSON.stringify(handoffPayload))

    const planner = new Planner(llm)
    const result = await planner.plan(
      'Je veux faire quelque chose avec mon équipe',
      genericProfile,
      'run-test-002',
    )

    expect(result.meta.confidence).toBe(70)
    expect(result.meta.confidence).toBeLessThan(85)
    expect(result.requires_human_approval).toBe(true)
    expect(result.meta.human_gate_points).toContain('before_execution')
  })

  it('throws on invalid JSON from LLM', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse('broken { json')

    const planner = new Planner(llm)
    await expect(
      planner.plan('any task', appProfile, 'run-err'),
    ).rejects.toThrow('Planner: LLM returned invalid JSON')
  })
})
