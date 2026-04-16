// lib/pipeline/ai-suggestions.ts
// Generates AI-proposed improvements to a PipelineTemplate DAG based on
// historical run outcomes (rating, cost, completion rate) for that template.
//
// The suggestion is stored in PipelineTemplate.ai_suggestion (JSON) and
// PipelineTemplate.ai_suggested_at. The user can accept it (which creates a
// new PipelineTemplateVersion with source='ai_suggestion') or dismiss it.
//
// This module intentionally avoids making network calls at import time —
// the LLM call only happens when generateSuggestion() is explicitly invoked
// (e.g. from the /api/pipeline-templates/:id/feedback route after a run completes).

import { Prisma }               from '@prisma/client'
import { db as _db }           from '@/lib/db/client'
import { createLLMClient }     from '@/lib/llm/client'
import type { Dag }            from '@/types/dag.types'
import type { PrismaClient }   from '@prisma/client'

// The db singleton uses a Proxy for lazy init; cast to the full type for TS.
const db = _db as PrismaClient

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunOutcome {
  id:          string
  user_rating: number | null   // 1–5
  cost_actual_usd: number
  tokens_actual:   number
  status:      string          // COMPLETED | FAILED | CANCELLED
  nodes:       Array<{ agent_type: string; status: string; retries: number }>
}

interface FeedbackInput {
  template_id: string
  run_id:      string
  user_rating?: number        // 1–5, optional — triggers suggestion if ≤ 3
  change_note?: string        // free-text from the user
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a run outcome against a template and optionally trigger an AI
 * improvement suggestion if quality signals warrant it.
 *
 * Triggers suggestion when:
 *   - user_rating ≤ 3, OR
 *   - run.status === 'FAILED', OR
 *   - any node has retries > 1
 */
export async function recordFeedback(input: FeedbackInput): Promise<void> {
  const template = await db.pipelineTemplate.findUnique({ where: { id: input.template_id } })
  if (!template) return

  const run = await db.run.findUnique({
    where: { id: input.run_id },
    include: { nodes: { select: { agent_type: true, status: true, retries: true } } },
  })
  if (!run) return

  const outcome: RunOutcome = {
    id:              run.id,
    user_rating:     input.user_rating ?? run.user_rating,
    cost_actual_usd: Number(run.cost_actual_usd),
    tokens_actual:   run.tokens_actual,
    status:          run.status,
    nodes:           run.nodes,
  }

  const shouldSuggest =
    (outcome.user_rating !== null && outcome.user_rating <= 3) ||
    outcome.status === 'FAILED' ||
    outcome.nodes.some((n) => n.retries > 1)

  if (shouldSuggest) {
    await generateSuggestion(template.id, template.dag as unknown as Dag, outcome)
  }
}

/**
 * Accept the current ai_suggestion, creating a new PipelineTemplateVersion.
 * Clears ai_suggestion after acceptance.
 */
export async function acceptSuggestion(template_id: string, accepted_by: string): Promise<void> {
  const template = await db.pipelineTemplate.findUniqueOrThrow({
    where: { id: template_id },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })

  if (!template.ai_suggestion) return

  const suggestion = template.ai_suggestion as { nodes: unknown[]; edges: unknown[]; rationale?: string }
  const newDag: Dag = { nodes: suggestion.nodes as Dag['nodes'], edges: suggestion.edges as Dag['edges'] }
  const lastVersion = template.versions[0]?.version ?? 0

  await db.$transaction([
    db.pipelineTemplate.update({
      where: { id: template_id },
      data: {
        dag:              newDag as object,
        ai_suggestion:    Prisma.JsonNull,  // clear after acceptance
        ai_suggested_at:  null,
      },
    }),
    db.pipelineTemplateVersion.create({
      data: {
        template_id,
        version:     lastVersion + 1,
        dag:         newDag as object,
        change_note: suggestion.rationale ?? 'AI-proposed improvement accepted',
        source:      'ai_suggestion',
        created_by:  accepted_by,
      },
    }),
  ])
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function generateSuggestion(
  template_id: string,
  currentDag: Dag,
  outcome: RunOutcome,
): Promise<void> {
  const llm = await createLLMClient()

  const prompt = buildPrompt(currentDag, outcome)

  let raw: string
  try {
    const result = await llm.chat([{ role: 'user', content: prompt }], {
      model:       'fast',   // resolved by DirectLLMClient tier alias
      maxTokens:   1024,
      temperature: 0.3,
    })
    raw = result.content
  } catch {
    // LLM unavailable — silently skip, don't break the feedback flow
    return
  }

  // Extract JSON block from the response
  const match = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/\{[\s\S]*\}/)
  if (!match) return

  let suggestion: { nodes: unknown[]; edges: unknown[]; rationale?: string }
  try {
    suggestion = JSON.parse(match[1] ?? match[0])
  } catch {
    return
  }

  if (!Array.isArray(suggestion.nodes) || !Array.isArray(suggestion.edges)) return

  await db.pipelineTemplate.update({
    where: { id: template_id },
    data: {
      ai_suggestion:   suggestion as object,
      ai_suggested_at: new Date(),
    },
  })
}

/**
 * SEC-C-02: Sanitize a value intended for use inside a prompt string.
 * Strips backtick sequences and "ignore/forget previous instructions" patterns
 * that an adversary could embed in node agent_type or other string fields
 * to escape the structured data context and inject prompt directives.
 */
function sanitizeForPrompt(value: string): string {
  return value
    // Remove backtick-fence sequences that could close/reopen code blocks
    .replace(/`{1,4}/g, "'")
    // Neutralise common prompt-injection openers
    .replace(/\b(ignore|forget|disregard|override|cancel)\s+(previous|prior|above|all)\s+(instructions?|rules?|context|prompt)/gi, '[REDACTED]')
    // Collapse to a safe maximum length — these are node metadata strings, never free-form
    .slice(0, 128)
}

function buildPrompt(dag: Dag, outcome: RunOutcome): string {
  // SEC-C-02: Sanitize all string fields that originate from DB rows (and therefore
  // from admin/user input) before interpolating them into the prompt.
  // Numbers (status counters, costs, token counts) are safe — no injection risk.
  const safeStatus = sanitizeForPrompt(outcome.status)
  const failedNodes = outcome.nodes
    .filter((n) => n.status !== 'COMPLETED')
    .map((n) => ({ agent_type: sanitizeForPrompt(n.agent_type), status: sanitizeForPrompt(n.status), retries: n.retries }))
  const highRetryNodes = outcome.nodes
    .filter((n) => n.retries > 1)
    .map((n) => ({ agent_type: sanitizeForPrompt(n.agent_type), status: sanitizeForPrompt(n.status), retries: n.retries }))

  return `You are an AI pipeline optimizer for Harmoven, a multi-agent orchestration platform.

A pipeline run has completed with the following outcome:
- Status: ${safeStatus}
- User rating: ${outcome.user_rating ?? 'not rated'}/5
- Cost: $${outcome.cost_actual_usd.toFixed(4)}
- Total tokens: ${outcome.tokens_actual}
- Failed nodes: ${JSON.stringify(failedNodes)}
- High-retry nodes: ${JSON.stringify(highRetryNodes)}

Current DAG definition:
\`\`\`json
${JSON.stringify(dag, null, 2)}
\`\`\`

Allowed agent_type values: CLASSIFIER, PLANNER, WRITER, REVIEWER, SMOKE_TEST, REPAIR, CRITICAL_REVIEW

Propose an improved DAG that addresses the observed issues. Return ONLY a JSON object with this structure:
\`\`\`json
{
  "nodes": [...],
  "edges": [...],
  "rationale": "Brief explanation of what changed and why"
}
\`\`\`

Rules:
- Keep the same node id format ("n1", "n2", etc.)
- Edges must reference valid node ids
- Only use the allowed agent_type values above
- Do not add more than 2 new nodes
- If the pipeline is already optimal, return the unchanged dag with rationale "No changes needed"
`
}
