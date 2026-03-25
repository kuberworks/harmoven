// lib/agents/classifier.ts
// IntentClassifier — fast domain detection on free-text user input.
// Spec: AGENTS-01-CORE.md Sections 2 and 5.1.
//
// Rules:
// - Uses the fast/cheap LLM tier (max 500 tokens output).
// - confidence ≥ 80 → no clarification needed.
// - confidence < 80 → requires_clarification = true, LLM populates clarification_questions.
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/mock-client'

// ─── Types ────────────────────────────────────────────────────────────────────

export type OutputType = 'document' | 'code' | 'data' | 'media' | 'action'

export type Domain =
  | 'marketing'
  | 'legal'
  | 'finance'
  | 'hr'
  | 'tech'
  | 'ops'
  | 'ecommerce'
  | 'training'
  | 'support'
  | 'generic'

export type ProfileId =
  | 'data_reporting'
  | 'app_scaffolding'
  | 'document_drafting'
  | 'research_synthesis'
  | 'marketing_content'
  | 'hr_recruiting'
  | 'legal_compliance'
  | 'finance_modeling'
  | 'customer_support'
  | 'ecommerce_ops'
  | 'training_content'
  | 'generic'

export interface ClassifierResult {
  classifier_version: string
  input_summary: string
  detected_profile: ProfileId
  output_type: OutputType
  domain: Domain
  /** 0–100. */
  confidence: number
  confidence_rationale: string
  /** Empty when confidence ≥ 80. Max 3 questions. */
  clarification_questions: string[]
  fallback_profile: ProfileId
  /** Plain-language banner text shown to user when confidence ≥ 80. */
  user_confirmation_text: string
  /** Derived: true when confidence < 80 → UI shows clarification flow. */
  requires_clarification: boolean
}

// ─── System prompt ────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `\
You are a fast intent classifier for Harmoven, an AI task execution system.
Given a user's free-text input, classify the intent and output ONLY valid JSON matching this schema:

{
  "classifier_version": "1.0",
  "input_summary": "<one sentence plain-language summary of what the user wants>",
  "detected_profile": "<profile id — see list below>",
  "output_type": "<document | code | data | media | action>",
  "domain": "<marketing | legal | finance | hr | tech | ops | ecommerce | training | support | generic>",
  "confidence": <integer 0-100>,
  "confidence_rationale": "<brief explanation of confidence level>",
  "clarification_questions": ["<question 1>"],
  "fallback_profile": "generic",
  "user_confirmation_text": "<plain language banner shown to user when confidence >= 80>"
}

Available profiles:
- data_reporting     → data | ops       CSV, Excel, analyse, dashboard, KPI
- app_scaffolding    → code | tech      app, build, website, SaaS, platform
- document_drafting  → document | ops   report, email, presentation, write
- research_synthesis → document | ops   research, market study, competitive analysis
- marketing_content  → document | marketing  post, campaign, SEO, newsletter
- hr_recruiting      → document | hr    job description, CV, onboarding
- legal_compliance   → document | legal contract, GDPR, compliance
- finance_modeling   → data | finance   business plan, forecast, budget, P&L
- customer_support   → document | support  FAQ, knowledge base, chatbot
- ecommerce_ops      → document | ecommerce  product listing, catalogue, pricing
- training_content   → document | training   course, quiz, e-learning
- generic            → document | generic   fallback when no strong signal

Rules:
- If confidence >= 80: clarification_questions = []
- If confidence < 80: include 2–3 targeted clarification questions
- Output ONLY the JSON object. No markdown fence, no prose.
- Max 500 tokens.`

// ─── Classifier ───────────────────────────────────────────────────────────────

export class IntentClassifier {
  constructor(private readonly llm: ILLMClient) {}

  async classify(input: string): Promise<ClassifierResult> {
    const result = await this.llm.chat(
      [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: input },
      ],
      { model: 'fast', maxTokens: 500 },
    )

    let parsed: unknown
    try {
      parsed = JSON.parse(result.content)
    } catch {
      throw new Error(
        `IntentClassifier: LLM returned invalid JSON — ${result.content.slice(0, 200)}`,
      )
    }

    const raw = parsed as Record<string, unknown>
    if (typeof raw['confidence'] !== 'number') {
      throw new Error(
        'IntentClassifier: missing or invalid "confidence" field in LLM response',
      )
    }

    return {
      ...(raw as Omit<ClassifierResult, 'requires_clarification'>),
      requires_clarification: (raw['confidence'] as number) < 80,
    }
  }
}
