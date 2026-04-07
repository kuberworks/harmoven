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

export type ReviewVerdict = 'APPROVE' | 'REQUEST_REVISION' | 'ESCALATE_HUMAN' | 'SPAWN_FOLLOWUP'

/**
 * A follow-up run the reviewer wants to spawn automatically.
 * Each task is passed as task_input to a new run in the same project.
 */
export interface FollowupTask {
  /** Short label displayed in the UI (e.g. "Generate budget summary PDF"). */
  label: string
  /** Full task description sent as the new run's task_input. */
  task: string
}

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
  /** Reviewer-reformatted Markdown consolidation. Set only when writer output(s) lack Markdown structure. */
  formatted_content?: string
  /**
   * Follow-up runs to spawn automatically (only present when verdict is SPAWN_FOLLOWUP).
   * Each entry yields a new independent run in the same project with this run as parent.
   */
  followup_tasks?: FollowupTask[]
  meta: {
    llm_used: string
    tokens_input: number
    tokens_output: number
    duration_seconds: number
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  profile: ProfileId,
  outputLanguage?: string,
  hasParallelExcelSheets?: boolean,
): string {
  const parallelSheetsRule = hasParallelExcelSheets
    ? `\nParallel worksheets rule (IMPORTANT — applies to this run):
- All writer outputs are INDIVIDUAL WORKSHEETS of a single unified workbook, each covering a
  distinct scope defined in the writer's assigned_task.
- Do NOT flag partial costs, subtotals, or section-level figures in one sheet as contradictions
  with aggregated totals in another sheet — these are additive components, not competing claims.
- DO flag when a key reference value (number of guests, event date, couple names, currency)
  differs across sheets — those are genuine inconsistencies.
- For each writer output, judge it against its own assigned_task (what that specific sheet was
  asked to produce), NOT against the outputs of sibling writer sheets.`
    : ''

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
  "verdict": "<APPROVE | REQUEST_REVISION | ESCALATE_HUMAN | SPAWN_FOLLOWUP>",
  "findings": [
    {
      "severity": "<info | warning | error>",
      "node_id": "<node id or 'global'>",
      "issue": "<brief description of the issue>",
      "recommendation": "<actionable fix>"
    }
  ],
  "overall_confidence": <integer 0-100>,
  "overall_confidence_rationale": "<brief explanation>",
  "formatted_content": "<optional — see Formatting instruction below>",
  "followup_tasks": [
    { "label": "<short UI label>", "task": "<full task description for the new run>" }
  ]
}

Universal checklist:
- Objective fully addressed vs task_summary
- All assumptions documented and reasonable
- No factual contradictions between parallel branches
- Output format matches expected_output_type
- No hallucinated data, figures, or unsourced claims
${languageRule}${parallelSheetsRule}
Profile-specific rules:
- app_scaffolding: flag if ESLint/tsc/docker-compose issues mentioned in output
- legal_compliance: must flag if "consult a lawyer" reminder is absent
- finance_modeling: flag any figures not traceable to input data
- data_reporting: flag statistics without source references
- marketing_content: flag missing CTA or invented brand claims

Verdict rules:
- APPROVE: no errors, warnings are acceptable
- REQUEST_REVISION: at least one error finding that the WRITER nodes can fix by revising their work
- ESCALATE_HUMAN: fundamental ambiguity or budget/scope blocker requiring human judgement
- SPAWN_FOLLOWUP: the current output is acceptable OR covers what was asked, but the overall
  goal requires additional independent work that cannot be done by revising the existing nodes
  (e.g. the run produced an Excel planning file but the user also needs a PDF summary, or a
  data-export run completed but a separate visualisation dashboard is still needed)

SPAWN_FOLLOWUP rules (IMPORTANT — only use when genuinely needed):
- Use SPAWN_FOLLOWUP only when additional VALUE-ADDING work is clearly implied by the task but
  was not covered by the current run's scope.
- Do NOT use SPAWN_FOLLOWUP to compensate for errors — use REQUEST_REVISION instead.
- Do NOT invent unnecessary follow-up tasks. Maximum 3 follow-up tasks per review.
- Each follow-up task must have a concise "label" (max 60 chars, visible in UI) and a
  complete, self-contained "task" description that a new run can execute independently.
- Set "followup_tasks" ONLY when verdict is SPAWN_FOLLOWUP. Omit it entirely otherwise.

Formatting instruction:
- Examine whether the writer outputs use proper Markdown structure (headings ##/###, bullet lists, bold, code blocks).
- If at least one writer output is plain text without Markdown formatting (e.g. raw scores, tabular data without | syntax, step-by-step lists without - prefix, algorithm names without code blocks), produce "formatted_content": a single consolidated, properly Markdown-formatted document combining all writer outputs in logical order. Apply appropriate headings, lists, and formatting. Technical terms (minmax, softmax, etc.) should be wrapped in backticks.
- If all writer outputs are already well-structured Markdown, OMIT "formatted_content" entirely (do not set it to null or empty string).

Output ONLY the JSON object. No markdown fence, no prose.`
}

// Maximum characters of writer content included in the reviewer prompt per node.
// Sending the full content (often 20K+ chars) inflates the input token count and
// leaves little room for the JSON output, causing the LLM to truncate mid-response.
// The reviewer only needs the summary + a representative excerpt to do its job.
const REVIEWER_CONTENT_EXCERPT_CHARS = 3000

// ─── Truncation recovery ──────────────────────────────────────────────────────

/**
 * Attempt to extract a usable ReviewerOutput from a truncated JSON string.
 * The LLM puts `verdict` first, so we can almost always recover that.
 * `findings` may be partially present — we keep only fully-formed objects.
 * Returns null if even the `verdict` is unrecoverable.
 */
function recoverTruncatedReviewerJson(raw: string): Record<string, unknown> | null {
  // Try to pull verdict — it's always the very first field.
  const verdictMatch = raw.match(/"verdict"\s*:\s*"([^"]+)"/)
  if (!verdictMatch) return null
  const verdict = verdictMatch[1]
  if (!['APPROVE', 'REQUEST_REVISION', 'ESCALATE_HUMAN', 'SPAWN_FOLLOWUP'].includes(verdict!)) return null

  // Extract all complete finding objects (must have all 4 required fields).
  const findings: ReviewFinding[] = []
  const findingRe = /\{[^{}]*"severity"\s*:\s*"([^"]+)"[^{}]*"node_id"\s*:\s*"([^"]+)"[^{}]*"issue"\s*:\s*"([^"]+)"[^{}]*"recommendation"\s*:\s*"([^"]+)"[^{}]*\}/g
  let m: RegExpExecArray | null
  while ((m = findingRe.exec(raw)) !== null) {
    findings.push({
      severity: m[1] as ReviewFinding['severity'],
      node_id: m[2]!,
      issue: m[3]!,
      recommendation: m[4]!,
    })
  }

  const confidenceMatch = raw.match(/"overall_confidence"\s*:\s*(\d+)/)
  const rationaleMatch  = raw.match(/"overall_confidence_rationale"\s*:\s*"([^"]+)"/)

  return {
    verdict,
    findings,
    overall_confidence:           confidenceMatch  ? parseInt(confidenceMatch[1]!, 10) : 50,
    overall_confidence_rationale: rationaleMatch?.[1] ?? 'Response was truncated — partial review only.',
  }
}

// ─── Reviewer ─────────────────────────────────────────────────────────────────

export interface ReviewerTaskContext {
  /** Assigned task description per writer node_id (from Planner metadata). */
  writerDescriptions: Record<string, string>
  /** The reviewer node's own assigned task description (from Planner metadata). */
  reviewerDescription?: string
}

export class Reviewer {
  constructor(private readonly llm: ILLMClient) {}

  async review(
    writerOutputs: WriterOutput[],
    profile: ProfileId,
    run_id: string,
    signal?: AbortSignal,
    outputLanguage?: string,
    taskContext?: ReviewerTaskContext,
  ): Promise<ReviewerOutput> {
    const startMs = Date.now()

    // Detect parallel-excel-sheets scenario: all writers have the same excel output type.
    const allOutputTypes = writerOutputs.map(w => w.output.type)
    const hasParallelExcelSheets =
      writerOutputs.length > 1 &&
      allOutputTypes.every(t => t === 'excel_file' || t === 'spreadsheet' || t === 'csv')

    const result = await withRetry(
      () => this.llm.chat(
        [
          { role: 'system', content: buildSystemPrompt(profile, outputLanguage, hasParallelExcelSheets) },
          {
            role: 'user',
            content: JSON.stringify({
              run_id,
              domain_profile: profile,
              // Reviewer's own assigned task — helps the LLM understand the consolidation goal.
              reviewer_task: taskContext?.reviewerDescription ?? null,
              writer_outputs: writerOutputs.map(w => ({
                node_id: w.source_node_id,
                // What this writer was specifically assigned to produce.
                assigned_task: taskContext?.writerDescriptions[w.source_node_id] ?? null,
                output_type: w.output.type,
                summary: w.output.summary,
                // Truncate content to avoid inflating context so much that the
                // JSON response itself gets cut at max_tokens.
                content: w.output.content.length > REVIEWER_CONTENT_EXCERPT_CHARS
                  ? w.output.content.slice(0, REVIEWER_CONTENT_EXCERPT_CHARS) + '\n…[truncated for review]'
                  : w.output.content,
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
      try {
        parsed = JSON.parse(stripped)
      } catch {
        // JSON may be truncated (LLM hit max_tokens mid-output). Try recovery.
        const recovered = recoverTruncatedReviewerJson(stripped)
        if (recovered) {
          console.warn(
            `[Reviewer] response truncated — recovered verdict="${recovered['verdict']}", ` +
            `${(recovered['findings'] as ReviewFinding[]).length} finding(s)`,
          )
          parsed = recovered
        } else {
          throw new SyntaxError('no recoverable JSON in reviewer response')
        }
      }
    } catch {
      throw new Error(
        `Reviewer: LLM returned invalid JSON — ${result.content.slice(0, 200)}`,
      )
    }

    const p = parsed as Record<string, unknown>
    if (!['APPROVE', 'REQUEST_REVISION', 'ESCALATE_HUMAN', 'SPAWN_FOLLOWUP'].includes(p['verdict'] as string)) {
      throw new Error(
        `Reviewer: invalid verdict "${p['verdict']}" — must be APPROVE | REQUEST_REVISION | ESCALATE_HUMAN | SPAWN_FOLLOWUP`,
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
      ...(typeof p['formatted_content'] === 'string' && p['formatted_content']
        ? { formatted_content: p['formatted_content'] as string }
        : {}),
      ...(p['verdict'] === 'SPAWN_FOLLOWUP' && Array.isArray(p['followup_tasks']) && p['followup_tasks'].length > 0
        ? {
            followup_tasks: (p['followup_tasks'] as Array<Record<string, unknown>>)
              .filter(t => typeof t['label'] === 'string' && typeof t['task'] === 'string')
              .slice(0, 3)  // cap at 3 — enforced server-side too
              .map(t => ({ label: t['label'] as string, task: t['task'] as string }))
          }
        : {}),
      meta: {
        llm_used: result.model,
        tokens_input: result.tokensIn,
        tokens_output: result.tokensOut,
        duration_seconds: durationSeconds,
      },
    }
  }
}
