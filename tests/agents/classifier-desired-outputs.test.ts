// tests/agents/classifier-desired-outputs.test.ts
// Tests: CLASSIFIER desired_outputs detection (MF-Phase3).
// Uses MockLLMClient — zero network / LLM cost.

import { IntentClassifier } from '@/lib/agents/classifier'
import { MockLLMClient } from '@/lib/llm/mock-client'
import type { ClassifierResult } from '@/lib/agents/classifier'

function makePayload(overrides: Partial<ClassifierResult> = {}): Record<string, unknown> {
  return {
    classifier_version: '1.0',
    input_summary: 'stub',
    detected_profile: 'data_reporting',
    output_type:       'data',
    domain:            'ops',
    confidence:        92,
    confidence_rationale: 'Strong signal',
    clarification_questions: [],
    fallback_profile: 'generic',
    user_confirmation_text: 'Sounds good.',
    ...overrides,
  }
}

describe('IntentClassifier — desired_outputs', () => {
  it('parses desired_outputs: CSV export intent', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify(makePayload({
        desired_outputs: [{ format: 'csv', description: 'exported data', produced_by: 'writer' }],
      })),
    )
    const result = await new IntentClassifier(llm).classify('exporte les données en CSV')
    expect(result.desired_outputs).toHaveLength(1)
    expect(result.desired_outputs![0]!.format).toBe('csv')
    expect(result.desired_outputs![0]!.produced_by).toBe('writer')
  })

  it('parses desired_outputs: Python script intent', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify(makePayload({
        desired_outputs: [{ format: 'py', description: 'Python script', produced_by: 'python' }],
      })),
    )
    const result = await new IntentClassifier(llm).classify('écris un script Python pour analyser les logs')
    expect(result.desired_outputs![0]!.format).toBe('py')
    expect(result.desired_outputs![0]!.produced_by).toBe('python')
  })

  it('returns desired_outputs=undefined when LLM omits the field (ambiguous request)', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify(makePayload()))
    const result = await new IntentClassifier(llm).classify('génère un rapport')
    expect(result.desired_outputs).toBeUndefined()
  })

  it('returns desired_outputs=undefined when LLM sets empty array', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(JSON.stringify(makePayload({ desired_outputs: [] })))
    const result = await new IntentClassifier(llm).classify('génère un rapport')
    expect(result.desired_outputs).toBeUndefined()
  })

  it('silently drops invalid desired_outputs entries (bad format)', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify(makePayload({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        desired_outputs: [{ format: 'invalid_format' as any, description: 'bad', produced_by: 'writer' }],
      })),
    )
    const result = await new IntentClassifier(llm).classify('exporte')
    // Invalid format is dropped — desired_outputs becomes undefined
    expect(result.desired_outputs).toBeUndefined()
  })

  it('parses multiple desired_outputs entries', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify(makePayload({
        desired_outputs: [
          { format: 'csv', description: 'data file', produced_by: 'writer' },
          { format: 'md', description: 'readme', produced_by: 'writer' },
        ],
      })),
    )
    const result = await new IntentClassifier(llm).classify('export CSV et un readme')
    expect(result.desired_outputs).toHaveLength(2)
    expect(result.desired_outputs![1]!.format).toBe('md')
  })
})
