// tests/agents/planner-format-routing.test.ts
// Tests: PLANNER output_file_format routing (MF-Phase3, C2 rule).
// Uses MockLLMClient — zero network / LLM cost.

jest.mock('@/lib/db/client', () => ({
  db: {
    run: {
      findUnique: jest.fn(),
    },
  },
}))

import { Planner } from '@/lib/agents/planner'
import { MockLLMClient } from '@/lib/llm/mock-client'
import type { PlannerHandoff } from '@/lib/agents/planner'
import type { ClassifierResult } from '@/lib/agents/classifier'

const mockDb = require('@/lib/db/client').db

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseProfile: ClassifierResult = {
  classifier_version: '1.0',
  input_summary: 'Generate a report',
  detected_profile: 'document_drafting',
  output_type: 'document',
  domain: 'ops',
  confidence: 90,
  confidence_rationale: 'Clear signal',
  clarification_questions: [],
  fallback_profile: 'generic',
  user_confirmation_text: 'Generating report.',
  requires_clarification: false,
}

function makeSingleWriterDAG(writerFormat?: string): PlannerHandoff {
  return {
    handoff_version: '1.0',
    source_agent: 'PLANNER',
    target_agent: 'DAG_EXECUTOR',
    run_id: 'run-test-001',
    domain_profile: 'document_drafting',
    task_summary: 'Generate a single-section report',
    assumptions: [],
    dag: {
      nodes: [
        {
          node_id: 'n1',
          agent: 'WRITER',
          description: 'Write the report',
          dependencies: [],
          llm_strategy: 'dynamic',
          complexity: 'medium',
          timeout_minutes: 15,
          inputs: [],
          expected_output_type: 'document',
          ...(writerFormat ? { output_file_format: writerFormat as 'md' } : {}),
        },
        {
          node_id: 'n2',
          agent: 'REVIEWER',
          description: 'Review the report',
          dependencies: ['n1'],
          llm_strategy: 'dynamic',
          complexity: 'medium',
          timeout_minutes: 10,
          inputs: ['output:n1'],
          expected_output_type: 'document',
        },
      ],
      edges: [{ from: 'n1', to: 'n2' }],
    },
    meta: {
      confidence: 90,
      confidence_rationale: 'Fine.',
      estimated_total_tokens: 2000,
      estimated_cost_usd: 0.01,
      estimated_duration_minutes: 5,
      parallel_branches: [],
      human_gate_points: [],
    },
    requires_human_approval: false,
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Planner — format routing (C2 rule)', () => {
  beforeEach(() => {
    // Default: no run_config.output_file_format
    mockDb.run.findUnique.mockResolvedValue({ run_config: {} })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('propagates desired_outputs csv from classifier to WRITER node', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify(makeSingleWriterDAG()))

    const profileWithDesired: ClassifierResult = {
      ...baseProfile,
      desired_outputs: [{ format: 'csv', description: 'data export', produced_by: 'writer' }],
    }

    const result = await new Planner(llm).plan('export data as CSV', profileWithDesired, 'run-test-001')
    const writerNode = result.dag.nodes.find(n => n.agent === 'WRITER')!
    expect(writerNode.output_file_format).toBe('csv')
  })

  it('does not set output_file_format when desired_outputs is undefined', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify(makeSingleWriterDAG()))

    const result = await new Planner(llm).plan('write a report', baseProfile, 'run-test-001')
    const writerNode = result.dag.nodes.find(n => n.agent === 'WRITER')!
    expect(writerNode.output_file_format).toBeUndefined()
  })

  it('C2: run_config.output_file_format overrides desired_outputs from classifier', async () => {
    // run_config has csv, classifier says docx → csv wins
    mockDb.run.findUnique.mockResolvedValue({ run_config: { output_file_format: 'csv' } })

    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify(makeSingleWriterDAG()))

    const profileWithDesired: ClassifierResult = {
      ...baseProfile,
      desired_outputs: [{ format: 'docx', description: 'docx report', produced_by: 'writer' }],
    }

    const result = await new Planner(llm).plan('generate a report', profileWithDesired, 'run-test-002')
    const writerNode = result.dag.nodes.find(n => n.agent === 'WRITER')!
    // csv wins — form selector always takes priority
    expect(writerNode.output_file_format).toBe('csv')
  })

  it('C2: run_config.output_file_format overrides even when no desired_outputs', async () => {
    mockDb.run.findUnique.mockResolvedValue({ run_config: { output_file_format: 'json' } })

    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify(makeSingleWriterDAG()))

    const result = await new Planner(llm).plan('generate report', baseProfile, 'run-test-003')
    const writerNode = result.dag.nodes.find(n => n.agent === 'WRITER')!
    expect(writerNode.output_file_format).toBe('json')
  })

  it('does not override output_file_format already set by LLM (desired_outputs path)', async () => {
    const llm = new MockLLMClient()
    // LLM already set output_file_format: 'md' on the WRITER node
    llm.setNextResponse(JSON.stringify(makeSingleWriterDAG('md')))

    const profileWithDesired: ClassifierResult = {
      ...baseProfile,
      desired_outputs: [{ format: 'csv', description: 'csv', produced_by: 'writer' }],
    }
    // No run_config.output_file_format (so C2 override does not apply)
    mockDb.run.findUnique.mockResolvedValue({ run_config: {} })

    const result = await new Planner(llm).plan('report', profileWithDesired, 'run-test-004')
    const writerNode = result.dag.nodes.find(n => n.agent === 'WRITER')!
    // LLM already set 'md', desired_outputs should not override it
    expect(writerNode.output_file_format).toBe('md')
  })
})
