// lib/agents/critical-reviewer.ts
// CriticalReviewer — deep quality gate executed after the Standard Reviewer approves.
// Spec: TECHNICAL.md Section 27, Amendment 75.
//
// Pipeline position:
//   Standard Reviewer (APPROVE / APPROVE_WITH_WARNINGS)
//        │
//        ▼
//   CriticalReviewer  ← this agent
//        │
//        ▼
//   Human Gate
//
// Skipped if Standard Reviewer issues REQUEST_REVISION.
//
// LLM assignment: always balanced tier or higher (never fast).
// Primary: claude-opus-4-6, fallback: claude-sonnet-4-6.
//
// Max findings: 3 (enforced in system prompt AND output parsing).
// Cost estimates: severity 1-2 ≈ $0.03-0.06 | 3-4 ≈ $0.06-0.12 | 5 ≈ $0.10-0.20

import type { ILLMClient } from '@/lib/llm/interface'
import type { WriterOutput } from '@/lib/agents/writer'
import { withRetry } from '@/lib/utils/retry'
import {
  type CriticalSeverity,
  type CriticalFinding,
  type CriticalReviewerOutput,
  resolveCriticalSeverity,
} from '@/lib/agents/reviewer/critical-reviewer.types'

export type { CriticalSeverity, CriticalFinding, CriticalReviewerOutput }
export { resolveCriticalSeverity }

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FINDINGS = 3

/** What each severity level checks — used to compose the system prompt. */
const SEVERITY_DESCRIPTIONS: Record<CriticalSeverity, string> = {
  0: 'Critical Reviewer is OFF. Do not produce any findings.',
  1: 'Lenient: Report ONLY security vulnerabilities causing data loss, legal violations, or hallucinated facts. Skip everything else.',
  2: 'Standard: Report security/data-loss issues AND architecture decisions obviously creating future pain, missing critical error handling, unreasonable assumptions, single points of failure.',
  3: 'Strict: Everything in Standard, PLUS scalability limits under 10x load, problematic coupling, missing observability, unsupported user-behaviour assumptions.',
  4: 'Thorough: Everything in Strict, PLUS alternative approaches worth knowing (informational), long-term maintenance burden, dependency risk, significant test gaps.',
  5: 'Paranoid: Everything in Thorough, PLUS every assumption questioned and backed by evidence, worst-case scenarios, regulatory edge cases, and adversarial misuse vectors.',
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(severity: CriticalSeverity): string {
  if (severity === 0) {
    return `You are a CriticalReviewer that is currently DISABLED (severity=0).
Respond with exactly: {"verdict":"no_issues","severity":0,"findings":[],"suppressed":0,"rationale":"Critical Reviewer disabled (severity=0)."}`
  }

  const today = new Date().toISOString().slice(0, 10)
  return `Today's date is ${today}. You MUST treat this as the real current date — do not consider any date on or before ${today} as a future date.

You are a Harmoven CriticalReviewer. You perform a deep adversarial review on the work produced by an AI agent pipeline.

Severity mode: ${severity} — ${SEVERITY_DESCRIPTIONS[severity]}

HARD RULES:
1. Produce EXACTLY ${MAX_FINDINGS} findings or fewer. Never more. Excess findings are DISCARDED.
2. State facts. Never hedge. Quantify impact with numbers when possible.
3. Respect the user's explicit technology choices — do not suggest switching stack.
4. Each finding must be independently actionable.
5. Do not repeat findings already surfaced by the Standard Reviewer.
6. If no findings meet the severity threshold, return verdict "no_issues".
7. Count findings below the threshold in "suppressed" — do not include them in "findings".

Severity labels:
- "blocking": must be fixed before release (security, data loss, legal)
- "important": should be fixed before release (significant risk)
- "watch": acceptable for now, revisit later (minor risk, informational at strict+)

Output ONLY this JSON (no markdown fence, no prose):
{
  "verdict": "<no_issues | issues_found>",
  "severity": <0-5 integer>,
  "findings": [
    {
      "id": "<uuid v4>",
      "severity": "<blocking | important | watch>",
      "title": "<max 10 words, direct>",
      "observation": "<factual, 1-2 sentences>",
      "impact": "<concrete consequence, 1 sentence>",
      "suggestion": "<actionable fix or null>",
      "domain": "<security | architecture | scalability | assumptions | compliance | hardware | maintenance | dependencies | safety>"
    }
  ],
  "suppressed": <integer — findings below threshold, not shown>,
  "rationale": "<1-2 sentence explanation of the overall assessment>"
}`
}

// ─── Output parser / validator ────────────────────────────────────────────────

function parseOutput(raw: string, severity: CriticalSeverity): Omit<CriticalReviewerOutput, 'meta'> {
  let parsed: Record<string, unknown>
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    parsed = JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    throw new Error(`[CriticalReviewer] Invalid JSON from LLM: ${raw.slice(0, 200)}`)
  }

  const verdict = parsed['verdict']
  if (verdict !== 'no_issues' && verdict !== 'issues_found') {
    throw new Error(`[CriticalReviewer] Invalid verdict: "${String(verdict)}"`)
  }

  const rawFindings = Array.isArray(parsed['findings']) ? (parsed['findings'] as unknown[]) : []
  // Enforce MAX 3 cap — LLM may hallucinate more
  const findings: CriticalFinding[] = rawFindings.slice(0, MAX_FINDINGS).map((f, i) => {
    const finding = f as Record<string, unknown>
    return {
      id:          typeof finding['id'] === 'string'         ? finding['id']          : `finding-${i}`,
      severity:    (['blocking', 'important', 'watch'].includes(finding['severity'] as string)
                    ? finding['severity'] : 'watch') as CriticalFinding['severity'],
      title:       typeof finding['title'] === 'string'      ? finding['title']       : '',
      observation: typeof finding['observation'] === 'string' ? finding['observation'] : '',
      impact:      typeof finding['impact'] === 'string'     ? finding['impact']      : '',
      suggestion:  typeof finding['suggestion'] === 'string' ? finding['suggestion']  : null,
      domain:      typeof finding['domain'] === 'string'     ? finding['domain']      : 'architecture',
    }
  })

  return {
    verdict:    verdict,
    severity,
    findings,
    suppressed: typeof parsed['suppressed'] === 'number' ? (parsed['suppressed'] as number) : 0,
    rationale:  typeof parsed['rationale'] === 'string'  ? (parsed['rationale'] as string)  : '',
  }
}

// ─── CriticalReviewer ─────────────────────────────────────────────────────────

export class CriticalReviewer {
  constructor(private readonly llm: ILLMClient) {}

  /**
   * Run the critical review at the given severity level.
   *
   * @param writerOutputs - All Writer node outputs for this run.
   * @param severity - Resolved CriticalSeverity (0–5). Use resolveCriticalSeverity().
   * @param run_id - Run identifier.
   * @param signal - AbortSignal for cancellation.
   */
  async review(
    writerOutputs: WriterOutput[],
    severity: CriticalSeverity,
    run_id: string,
    signal?: AbortSignal,
  ): Promise<CriticalReviewerOutput> {
    const startMs = Date.now()

    // severity=0 means disabled — return early without LLM call
    if (severity === 0) {
      return {
        verdict:    'no_issues',
        severity:   0,
        findings:   [],
        suppressed: 0,
        rationale:  'Critical Reviewer disabled (severity=0).',
        meta: {
          llm_used:         'none',
          tokens_input:     0,
          tokens_output:    0,
          duration_seconds: 0,
          cost_usd:         0,
        },
      }
    }

    const result = await withRetry(
      () => this.llm.chat(
        [
          { role: 'system', content: buildSystemPrompt(severity) },
          {
            role: 'user',
            content: JSON.stringify({
              run_id,
              severity,
              writer_outputs: writerOutputs.map(w => ({
                node_id:          w.source_node_id,
                output_type:      w.output.type,
                summary:          w.output.summary,
                content:          w.output.content,
                confidence:       w.output.confidence,
                assumptions_made: w.assumptions_made,
              })),
            }),
          },
        ],
        {
          // Hard floor: balanced tier — never fast models (Section 27.8)
          // Primary: claude-opus-4-6 (powerful), fallback: claude-sonnet-4-6 (balanced).
          model:     'powerful',
          maxTokens: 2000,
          signal,
        },
      ),
      { maxAttempts: 2, delaysMs: [1000], signal },
    )

    const durationSeconds = (Date.now() - startMs) / 1000
    const parsed = parseOutput(result.content, severity)

    return {
      ...parsed,
      meta: {
        llm_used:         result.model,
        tokens_input:     result.tokensIn,
        tokens_output:    result.tokensOut,
        duration_seconds: durationSeconds,
        cost_usd:         0, // populated by DirectLLMClient billing hooks
      },
    }
  }
}
