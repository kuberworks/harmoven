// lib/agents/classifier.ts
// IntentClassifier — fast domain detection on free-text user input.
// Spec: AGENTS-01-CORE.md Sections 2 and 5.1.
//
// Rules:
// - Uses the fast/cheap LLM tier (max 500 tokens output).
// - confidence ≥ 80 → no clarification needed.
// - confidence < 80 → requires_clarification = true, LLM populates clarification_questions.
// - All LLM response fields validated before returning (no blind cast).
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/interface'
import { withRetry } from '@/lib/utils/retry'

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

const VALID_PROFILES = new Set<ProfileId>([
  'data_reporting', 'app_scaffolding', 'document_drafting', 'research_synthesis',
  'marketing_content', 'hr_recruiting', 'legal_compliance', 'finance_modeling',
  'customer_support', 'ecommerce_ops', 'training_content', 'generic',
])

const VALID_OUTPUT_TYPES = new Set<OutputType>(['document', 'code', 'data', 'media', 'action'])

const VALID_DOMAINS = new Set<Domain>([
  'marketing', 'legal', 'finance', 'hr', 'tech', 'ops', 'ecommerce', 'training', 'support', 'generic',
])

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

// ─── Validation ───────────────────────────────────────────────────────────────

function validateClassifierResponse(raw: Record<string, unknown>): ClassifierResult {
  const confidence = raw['confidence']
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 100) {
    throw new Error('IntentClassifier: missing or invalid "confidence" (must be 0–100)')
  }

  const profile = raw['detected_profile'] as string
  if (!VALID_PROFILES.has(profile as ProfileId)) {
    throw new Error(`IntentClassifier: unknown detected_profile "${profile}" — falling back to generic`)
  }

  const outputType = raw['output_type'] as string
  if (!VALID_OUTPUT_TYPES.has(outputType as OutputType)) {
    throw new Error(`IntentClassifier: invalid output_type "${outputType}"`)
  }

  const domain = raw['domain'] as string
  if (!VALID_DOMAINS.has(domain as Domain)) {
    throw new Error(`IntentClassifier: invalid domain "${domain}"`)
  }

  if (typeof raw['input_summary'] !== 'string' || !raw['input_summary']) {
    throw new Error('IntentClassifier: missing "input_summary" field')
  }

  if (typeof raw['confidence_rationale'] !== 'string') {
    throw new Error('IntentClassifier: missing "confidence_rationale" field')
  }

  if (typeof raw['user_confirmation_text'] !== 'string') {
    throw new Error('IntentClassifier: missing "user_confirmation_text" field')
  }

  const questions = Array.isArray(raw['clarification_questions'])
    ? (raw['clarification_questions'] as string[]).slice(0, 3)
    : []

  return {
    classifier_version: (raw['classifier_version'] as string) ?? '1.0',
    input_summary: raw['input_summary'] as string,
    detected_profile: profile as ProfileId,
    output_type: outputType as OutputType,
    domain: domain as Domain,
    confidence,
    confidence_rationale: raw['confidence_rationale'] as string,
    clarification_questions: questions,
    fallback_profile: VALID_PROFILES.has(raw['fallback_profile'] as ProfileId)
      ? (raw['fallback_profile'] as ProfileId)
      : 'generic',
    user_confirmation_text: raw['user_confirmation_text'] as string,
    requires_clarification: confidence < 80,
  }
}

// ─── Classifier ───────────────────────────────────────────────────────────────

export class IntentClassifier {
  constructor(private readonly llm: ILLMClient) {}

  async classify(input: string, signal?: AbortSignal): Promise<ClassifierResult> {
    const result = await withRetry(
      () => this.llm.chat(
        [
          { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        { model: 'fast', maxTokens: 500, signal },
      ),
      {
        signal,
        onRetry: (err, attempt) =>
          console.warn(`[IntentClassifier] attempt ${attempt} failed:`, err),
      },
    )

    let parsed: unknown
    try {
      // Strip markdown code fences (```json ... ``` or ``` ... ```) that some
      // models emit even when prompted for raw JSON.
      const stripped = result.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      parsed = JSON.parse(stripped)
    } catch {
      throw new Error(
        `IntentClassifier: LLM returned invalid JSON — ${result.content.slice(0, 200)}`,
      )
    }

    return validateClassifierResponse(parsed as Record<string, unknown>)
  }
}
