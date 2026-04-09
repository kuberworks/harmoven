// lib/agents/classifier.ts
// IntentClassifier — fast domain detection on free-text user input.
// Spec: AGENTS-01-CORE.md Sections 2 and 5.1.
//
// Rules:
// - Uses the fast/cheap LLM tier (max 2048 tokens output).
// - confidence ≥ 80 → no clarification needed.
// - confidence < 80 → requires_clarification = true, LLM populates clarification_questions.
// - All LLM response fields validated before returning (no blind cast).
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/interface'
import type { DesiredOutput } from '@/lib/agents/handoff'
import { DesiredOutputSchema } from '@/lib/agents/handoff'
import { withRetry } from '@/lib/utils/retry'
import { z } from 'zod'

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
  /**
   * Optional list of output formats detected from user intent.
   * Set only when the intent is unambiguous (e.g. "export to CSV").
   * Spec: multi-format-artifact-output.feature.md Part 1 §1.1
   */
  desired_outputs?: DesiredOutput[]
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
  "user_confirmation_text": "<plain language banner shown to user when confidence >= 80>",
  "desired_outputs": [
    { "format": "<txt|csv|json|yaml|html|md|py|ts|js|sh|docx|pdf>", "description": "<what this file contains>", "produced_by": "<writer|python>" }
  ]
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
- Be concise — the full response must fit in 2048 tokens.

OPTIONAL OUTPUT FORMAT DETECTION:
If the user explicitly requests a specific file format or document type, add a
"desired_outputs" array. Only set this if the intent is unambiguous.

Examples that SHOULD set desired_outputs:
- "generate a Word report" → [{ "format": "docx", "description": "final report", "produced_by": "writer" }]
- "export to CSV" → [{ "format": "csv", "description": "exported data", "produced_by": "writer" }]
- "write a Python script" → [{ "format": "py", "description": "Python script", "produced_by": "python" }]
- "create a JSON config file" → [{ "format": "json", "description": "configuration file", "produced_by": "writer" }]

Examples that should NOT set desired_outputs (format is ambiguous OR the output is a zip of files created by PYTHON_EXECUTOR):
- "generate a report" (no format specified)
- "create a document" (no format specified)
- "write some content" (no format specified)
- "create a Spring Boot / Node.js / React / Django project" (→ zip produced by PYTHON_EXECUTOR; do NOT set desired_outputs)
- "scaffold an app" (→ PYTHON_EXECUTOR creates the files; do NOT set desired_outputs)

Do NOT set desired_outputs if the intent is ambiguous — it is better to omit it than to guess.
Omit the "desired_outputs" key entirely when not applicable.`

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

  // user_confirmation_text is a non-critical display field (UI banner).
  // Some LLMs omit it — fall back to input_summary rather than crashing the run.
  const userConfirmationText = typeof raw['user_confirmation_text'] === 'string'
    ? raw['user_confirmation_text']
    : (raw['input_summary'] as string)

  const questions = Array.isArray(raw['clarification_questions'])
    ? (raw['clarification_questions'] as string[]).slice(0, 3)
    : []

  // Parse optional desired_outputs — invalid or badly-shaped entries are silently dropped.
  let desiredOutputs: DesiredOutput[] | undefined
  if (Array.isArray(raw['desired_outputs']) && (raw['desired_outputs'] as unknown[]).length > 0) {
    const DesiredOutputArraySchema = z.array(DesiredOutputSchema)
    const doResult = DesiredOutputArraySchema.safeParse(raw['desired_outputs'])
    if (doResult.success && doResult.data.length > 0) {
      desiredOutputs = doResult.data
    }
  }

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
    user_confirmation_text: userConfirmationText,
    requires_clarification: confidence < 80,
    desired_outputs: desiredOutputs,
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
        { model: 'fast', maxTokens: 2048, signal },
      ),
      {
        signal,
        onRetry: (err, attempt) =>
          console.warn(`[IntentClassifier] attempt ${attempt} failed:`, err),
      },
    )

    let parsed: unknown
    const content = result.content ?? ''
    try {
      // Attempt 1: strip markdown fences from start/end then parse.
      let raw = content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim()
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Attempt 2: the model may have wrapped JSON in prose — extract the
        // first {...} block (greedy, handles multi-line JSON objects).
        const match = raw.match(/\{[\s\S]*\}/)
        if (!match) throw new Error('no JSON object found in response')
        parsed = JSON.parse(match[0])
      }
    } catch {
      throw new Error(
        `IntentClassifier: LLM returned invalid JSON — ${content.slice(0, 300)}`,
      )
    }

    return validateClassifierResponse(parsed as Record<string, unknown>)
  }
}
