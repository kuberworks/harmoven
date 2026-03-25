// tests/agents/classifier.test.ts
// Unit tests for IntentClassifier — 3 scenarios.
// Uses MockLLMClient — zero network / LLM cost.

import { IntentClassifier } from '@/lib/agents/classifier'
import { MockLLMClient } from '@/lib/llm/mock-client'
import type { ClassifierResult } from '@/lib/agents/classifier'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeClassifierPayload(overrides: Partial<ClassifierResult>): ClassifierResult {
  return {
    classifier_version: '1.0',
    input_summary: 'stub input summary',
    detected_profile: 'generic',
    output_type: 'document',
    domain: 'generic',
    confidence: 90,
    confidence_rationale: 'stub',
    clarification_questions: [],
    fallback_profile: 'generic',
    user_confirmation_text: 'Stub confirmation text.',
    requires_clarification: false,
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IntentClassifier', () => {
  it('classifies an app scaffolding request with high confidence', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify(
        makeClassifierPayload({
          input_summary: 'User wants to build a restaurant reservation web app',
          detected_profile: 'app_scaffolding',
          output_type: 'code',
          domain: 'tech',
          confidence: 94,
          confidence_rationale: 'Strong tech + app signals. No ambiguity.',
          user_confirmation_text:
            "It looks like you want to build an app. I'll set this up as a code project.",
        }),
      ),
    )

    const classifier = new IntentClassifier(llm)
    const result = await classifier.classify('I want to build a restaurant reservation app')

    expect(result.detected_profile).toBe('app_scaffolding')
    expect(result.output_type).toBe('code')
    expect(result.domain).toBe('tech')
    expect(result.confidence).toBe(94)
    expect(result.requires_clarification).toBe(false)
    expect(result.clarification_questions).toHaveLength(0)

    // Verify LLM was called once with correct tier and user message
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0].options.model).toBe('fast')
    expect(llm.calls[0].messages[0].role).toBe('system')
    expect(llm.calls[0].messages[1].role).toBe('user')
    expect(llm.calls[0].messages[1].content).toContain('restaurant reservation')
  })

  it('classifies a marketing content request with high confidence', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify(
        makeClassifierPayload({
          input_summary: 'User wants to write a LinkedIn post for a product launch',
          detected_profile: 'marketing_content',
          output_type: 'document',
          domain: 'marketing',
          confidence: 88,
          confidence_rationale: 'Clear marketing + social media signals.',
          user_confirmation_text:
            "It looks like you want to create marketing content. I'll set this up as a Marketing & Content project.",
        }),
      ),
    )

    const classifier = new IntentClassifier(llm)
    const result = await classifier.classify(
      'Rédige un post LinkedIn pour lancer mon produit',
    )

    expect(result.detected_profile).toBe('marketing_content')
    expect(result.output_type).toBe('document')
    expect(result.domain).toBe('marketing')
    expect(result.confidence).toBe(88)
    expect(result.requires_clarification).toBe(false)
    expect(result.clarification_questions).toHaveLength(0)
  })

  it('triggers the clarification gate when confidence is below 80', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(
      JSON.stringify(
        makeClassifierPayload({
          input_summary: 'User wants to do something with their data, intent unclear',
          detected_profile: 'generic',
          output_type: 'document',
          domain: 'generic',
          confidence: 55,
          confidence_rationale:
            'Ambiguous — could be data reporting, analysis, or something else entirely.',
          clarification_questions: [
            'What type of data do you have (e.g. spreadsheet, database, survey)?',
            'What would you like the end result to look like (e.g. dashboard, report, export)?',
          ],
          user_confirmation_text: '',
        }),
      ),
    )

    const classifier = new IntentClassifier(llm)
    const result = await classifier.classify(
      'Je voudrais faire quelque chose avec mes données',
    )

    expect(result.confidence).toBe(55)
    expect(result.confidence).toBeLessThan(80)
    expect(result.requires_clarification).toBe(true)
    expect(result.clarification_questions.length).toBeGreaterThan(0)
    expect(result.clarification_questions[0]).toContain('data')
  })

  it('throws on invalid JSON from LLM', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse('not valid json {{ garbage')

    const classifier = new IntentClassifier(llm)
    await expect(
      classifier.classify('any input'),
    ).rejects.toThrow('IntentClassifier: LLM returned invalid JSON')
  })
})
