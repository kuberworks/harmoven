// lib/agents/reviewer.ts
// Reviewer — quality gate executed after all Writer nodes complete.
// Spec: AGENTS-01-CORE.md Section 5.4.
//
// Rules:
// - Always uses the powerful LLM tier.
// - Verdict: APPROVE | REQUEST_REVISION | ESCALATE_HUMAN
// - Receives all WriterOutput handoffs for the run.
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/interface'
import type { ProfileId } from '@/lib/agents/classifier'
import type { WriterOutput } from '@/lib/agents/writer'
import { withRetry } from '@/lib/utils/retry'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReviewVerdict = 'APPROVE' | 'REQUEST_REVISION' | 'ESCALATE_HUMAN'

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'error'
  node_id: string
  issue: string
  recommendation: string
}

export interface ReviewerOutput {
  handoff_version: string
  source_agent: 'REVIEWER'
  target: 'HUMAN_GATE'
  run_id: string
  verdict: ReviewVerdict
  findings: ReviewFinding[]
  overall_confidence: number
  overall_confidence_rationale: string
  meta: {
    llm_used: string
    tokens_input: number
    tokens_output: number
    duration_seconds: number
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(profile: ProfileId, outputLanguage?: string): string {
  const languageRule = outputLanguage
    ? `\nLanguage rule (IMPORTANT):
- The expected output language is: ${outputLanguage}
- Technical vocabulary, algorithm names, mathematical terms (e.g. "minmax", "softmax",
  "backpropagation"), programming keywords, domain-specific jargon, proper nouns, acronyms,
  and internationally adopted scientific/technical words are acceptable in text of any
  language. Do NOT flag them as language inconsistencies.
- Only flag a language inconsistency when the main narrative prose switches to a language
  other than ${outputLanguage} for full sentences or paragraphs.`
    : `\nLanguage rule:
- Technical vocabulary, algorithm names, mathematical terms, programming keywords,
  domain-specific jargon, proper nouns, and internationally adopted scientific/technical
  words are acceptable regardless of their origin language. Do NOT flag them as language
  inconsistencies. Only flag genuine narrative prose written in an unintended language.`

  return `\
You are a Harmoven Reviewer agent performing a quality gate review for a "${profile}" project.
You will receive the outputs from all Writer nodes. Review them against the universal checklist
and any profile-specific rules, then respond ONLY with valid JSON matching this schema:

{
  "verdict": "<APPROVE | REQUEST_REVISION | ESCALATE_HUMAN>",
  "findings": [
    {
      "severity": "<info | warning | error>",
      "node_id": "<node id or 'global'>",
      "issue": "<brief description of the issue>",
      "recommendation": "<actionable fix>"
    }
  ],
  "overall_confidence": <integer 0-100>,
  "overall_confidence_rationale": "<brief explanation>"
}

Universal checklist:
- Objective fully addressed vs task_summary
- All assumptions documented and reasonable
- No factual contradictions between parallel branches
- Output format matches expected_output_type
- No hallucinated data, figures, or unsourced claims
${languageRule}
Profile-specific rules:
- app_scaffolding: flag if ESLint/tsc/docker-compose issues mentioned in output
- legal_compliance: must flag if "consult a lawyer" reminder is absent
- finance_modeling: flag any figures not traceable to input data
- data_reporting: flag statistics without source references
- marketing_content: flag missing CTA or invented brand claims

Verdict rules:
- APPROVE: no errors, warnings are acceptable
- REQUEST_REVISION: at least one error finding
- ESCALATE_HUMAN: fundamental ambiguity or budget/scope blocker

Output ONLY the JSON object. No markdown fence, no prose.`
}

// ─── Reviewer ─────────────────────────────────────────────────────────────────

export class Reviewer {
  constructor(private readonly llm: ILLMClient) {}

  async review(
    writerOutputs: WriterOutput[],
    profile: ProfileId,
    run_id: string,
    signal?: AbortSignal,
    outputLanguage?: string,
  ): Promise<ReviewerOutput> {
    const startMs = Date.now()

    const result = await withRetry(
      () => this.llm.chat(
        [
          { role: 'system', content: buildSystemPrompt(profile, outputLanguage) },
          {
            role: 'user',
            content: JSON.stringify({
              run_id,
              domain_profile: profile,
              writer_outputs: writerOutputs.map(w => ({
                node_id: w.source_node_id,
                output_type: w.output.type,
                summary: w.output.summary,
                content: w.output.content,
                confidence: w.output.confidence,
                assumptions_made: w.assumptions_made,
              })),
            }),
          },
        ],
        { model: 'powerful', signal },
      ),
      {
        signal,
        onRetry: (err, attempt) =>
          console.warn(`[Reviewer] attempt ${attempt} failed:`, err),
      },
    )

    let parsed: unknown
    try {
      const stripped = result.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      parsed = JSON.parse(stripped)
    } catch {
      throw new Error(
        `Reviewer: LLM returned invalid JSON — ${result.content.slice(0, 200)}`,
      )
    }

    const p = parsed as Record<string, unknown>
    if (!['APPROVE', 'REQUEST_REVISION', 'ESCALATE_HUMAN'].includes(p['verdict'] as string)) {
      throw new Error(
        `Reviewer: invalid verdict "${p['verdict']}" — must be APPROVE | REQUEST_REVISION | ESCALATE_HUMAN`,
      )
    }

    const overallConfidence = typeof p['overall_confidence'] === 'number'
      ? Math.min(100, Math.max(0, p['overall_confidence'] as number))
      : 0

    const durationSeconds = Math.round((Date.now() - startMs) / 1000)

    return {
      handoff_version: '1.0',
      source_agent: 'REVIEWER',
      target: 'HUMAN_GATE',
      run_id,
      verdict: p['verdict'] as ReviewVerdict,
      findings: (p['findings'] as ReviewFinding[]) ?? [],
      overall_confidence: overallConfidence,
      overall_confidence_rationale: p['overall_confidence_rationale'] as string,
      meta: {
        llm_used: result.model,
        tokens_input: result.tokensIn,
        tokens_output: result.tokensOut,
        duration_seconds: durationSeconds,
      },
    }
  }
}
