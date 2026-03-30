// lib/agents/writer.ts
// Writer — executes a single leaf node and produces output via the LLM.
// Spec: AGENTS-01-CORE.md Section 5.3.
//
// Rules:
// - LLM tier is determined by node complexity: low→fast, medium→balanced, high→powerful.
// - Streaming: tokens forwarded via onChunk callback (SSE wired in T1.8; stub here).
// - AbortSignal propagated through to the LLM call.
// - Retry: Am.6.C — max 3 attempts, exponential backoff 5/15/45s ±20%.
// - upstream_inputs sanitized (Section 24): truncated to 500K chars max.
// - output.confidence validated to 0–100 range.
// - Real LLM wired in T1.9; MockLLMClient used in all unit tests.

import type { ILLMClient } from '@/lib/llm/interface'
import type { ProfileId } from '@/lib/agents/classifier'
import { withRetry } from '@/lib/utils/retry'
import { AgentCostError } from '@/lib/agents/agent-cost-error'

/** Max chars of upstream input content forwarded to the LLM (Section 24). */
const MAX_UPSTREAM_INPUT_CHARS = 500_000

// ─── Types ────────────────────────────────────────────────────────────────────

export type Complexity = 'low' | 'medium' | 'high'

export interface WriterNodeInput {
  node_id: string
  description: string
  complexity: Complexity
  expected_output_type: string
  /** Serialised outputs from upstream nodes, keyed by "output:nX" reference. */
  inputs: Record<string, unknown>
  domain_profile: ProfileId
  run_id: string
}

export interface WriterOutput {
  handoff_version: string
  source_agent: 'WRITER'
  source_node_id: string
  target_agent: 'REVIEWER'
  run_id: string
  output: {
    type: string
    summary: string
    content: string
    confidence: number
    confidence_rationale: string
  }
  assumptions_made: string[]
  execution_meta: {
    llm_used: string
    tokens_input: number
    tokens_output: number
    duration_seconds: number
    retries: number
  }
  lateral_delegation_request: null
}

// ─── Complexity → LLM tier mapping ─────────────────────────────────────────

const TIER: Record<Complexity, string> = {
  low: 'fast',
  medium: 'balanced',
  high: 'powerful',
}

/**
 * Max output tokens per complexity tier.
 * Writers produce full file content — 4096 (the global default) is too small
 * for medium/high tasks and causes truncated JSON responses.
 */
const MAX_TOKENS: Record<Complexity, number> = {
  low:    4096,
  medium: 8192,
  high:   16384,
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(profile: ProfileId): string {
  return `\
You are a Harmoven Writer agent executing a single task node for a "${profile}" project.
Produce the requested output and respond ONLY with valid JSON matching this schema:

{
  "output": {
    "type": "<document | code | data | media>",
    "summary": "<one sentence plain-language summary of what was produced>",
    "content": "<full output content as a string>",
    "confidence": <integer 0-100>,
    "confidence_rationale": "<brief explanation>"
  },
  "assumptions_made": ["<assumption 1>"]
}

Rules:
- Output ONLY the JSON object. No markdown fence, no prose.
- assumptions_made: list every decision you made that was not explicit in the task.
- confidence < 80 means the output needs revision.`
}

// ─── Input sanitizer (Section 24) ────────────────────────────────────────────

/**
 * Suspicious content patterns that indicate a prompt injection attempt
 * embedded in upstream node outputs (Section 24).
 * Matches common role-override phrases injected via external data.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above)\s+instructions/i,
  /you\s+are\s+now\s+(a\s+)?(?!a\s+Harmoven)/i,
  /disregard\s+(your|all|previous)\s+(instructions|rules|guidelines)/i,
  /<\|(?:im_start|im_end|system|user|assistant)\|>/i,   // ChatML injection
  /\[\s*SYSTEM\s*\]/i,
  /\[\s*INST\s*\]/i,
]

/**
 * Sanitize upstream inputs before injecting into a prompt (Section 24).
 * - Strips null bytes and C0/C1 control characters (except whitespace).
 * - Normalises unicode to NFC.
 * - Scans for prompt injection patterns — replaces the full string with a
 *   safe placeholder that signals the issue to the LLM without leaking content.
 * - Truncates to MAX_UPSTREAM_INPUT_CHARS (500K limit).
 */
function sanitizeUpstreamInputs(inputs: Record<string, unknown>): string {
  let serialized = JSON.stringify(inputs)
    // Strip null bytes and non-whitespace C0/C1 control chars (\x00-\x08, \x0b-\x0c, \x0e-\x1f, \x7f-\x9f)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .normalize('NFC')

  // Detect and neutralise role-injection attempts
  if (INJECTION_PATTERNS.some(re => re.test(serialized))) {
    console.warn('[Writer] Suspicious content detected in upstream inputs — sanitized.')
    serialized = JSON.stringify({ __sanitized: true, reason: 'suspicious_content_detected' })
  }

  if (serialized.length > MAX_UPSTREAM_INPUT_CHARS) {
    serialized = serialized.slice(0, MAX_UPSTREAM_INPUT_CHARS) + '[TRUNCATED]'
  }
  return serialized
}

// ─── Writer ───────────────────────────────────────────────────────────────────

export class Writer {
  constructor(private readonly llm: ILLMClient) {}

  async execute(
    node: WriterNodeInput,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void,
  ): Promise<WriterOutput> {
    const tier = TIER[node.complexity]
    const startMs = Date.now()
    let retries = 0

    const messages = [
      { role: 'system' as const, content: buildSystemPrompt(node.domain_profile) },
      {
        role: 'user' as const,
        content: JSON.stringify({
          task: node.description,
          expected_output_type: node.expected_output_type,
          upstream_inputs: sanitizeUpstreamInputs(node.inputs),
        }),
      },
    ]

    let raw: string
    let tokensIn: number
    let tokensOut: number
    let costUsd = 0
    let modelUsed: string

    if (onChunk) {
      // Streaming does not retry (chunks already emitted to client)
      const result = await this.llm.stream(messages, { model: tier, maxTokens: MAX_TOKENS[node.complexity], signal }, onChunk)
      raw = result.content
      tokensIn = result.tokensIn
      tokensOut = result.tokensOut
      costUsd = result.costUsd ?? 0
      modelUsed = result.model
    } else {
      const result = await withRetry(
        () => this.llm.chat(messages, { model: tier, maxTokens: MAX_TOKENS[node.complexity], signal }),
        {
          signal,
          onRetry: (err, attempt) => {
            retries = attempt
            console.warn(`[Writer(${node.node_id})] attempt ${attempt} failed:`, err)
          },
        },
      )
      raw = result.content
      tokensIn = result.tokensIn
      tokensOut = result.tokensOut
      costUsd = result.costUsd ?? 0
      modelUsed = result.model
    }

    let parsed: unknown
    try {
      // Strip leading/trailing markdown code fences, then try direct parse.
      // If that fails, try to extract the first complete JSON object from the response
      // (some models embed JSON inside prose or add trailing text after the object).
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      try {
        parsed = JSON.parse(stripped)
      } catch {
        // Fallback 1: find the outermost JSON object in the response
        const match = stripped.match(/(\{[\s\S]*\})/)
        if (match) {
          try {
            parsed = JSON.parse(match[1]!)
          } catch {
            // Fallback 2: the JSON was truncated (LLM hit max_tokens mid-output).
            // Attempt to recover: extract the "content" field value collected so far
            // and close the JSON manually so we can return a partial result rather
            // than failing the entire run.
            const partial = match[1]!
            const contentMatch = partial.match(/"content"\s*:\s*"([\s\S]*?)(?="confidence"|"confidence_rationale"|"\s*\}|$)/)
            const contentSoFar = contentMatch
              ? contentMatch[1]!
                  .replace(/\\n/g, '\n')
                  .replace(/\\t/g, '\t')
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, '\\')
              : ''
            const typeMatch  = partial.match(/"type"\s*:\s*"([^"]+)"/)
            const summaryMatch = partial.match(/"summary"\s*:\s*"([^"]+)"/)
            console.warn(
              `[Writer(${node.node_id})] response truncated — recovering partial content ` +
              `(${contentSoFar.length} chars recovered)`,
            )
            parsed = {
              output: {
                type:                 typeMatch?.[1]   ?? 'document',
                summary:              summaryMatch?.[1] ?? 'Partial output (response truncated)',
                content:              contentSoFar + '\n[OUTPUT TRUNCATED — increase max_tokens or reduce task scope]',
                confidence:           30,
                confidence_rationale: 'LLM response was truncated before completion. Output may be incomplete.',
              },
              assumptions_made: ['Response was truncated by the model token limit; only partial content was recovered.'],
            }
          }
        } else {
          throw new SyntaxError('no JSON object found')
        }
      }
    } catch {
      console.error(`[Writer(${node.node_id})] full raw response:`, raw)
      throw new AgentCostError(
        `Writer(${node.node_id}): LLM returned invalid JSON — ${raw.slice(0, 200)}`,
        costUsd, tokensIn, tokensOut,
      )
    }

    const p = parsed as Record<string, unknown>
    const output = p['output'] as Record<string, unknown> | undefined
    if (!output || typeof output['confidence'] !== 'number') {
      throw new AgentCostError(
        `Writer(${node.node_id}): missing or invalid "output.confidence" in LLM response`,
        costUsd, tokensIn, tokensOut,
      )
    }

    // Clamp confidence to 0–100
    output['confidence'] = Math.min(100, Math.max(0, output['confidence'] as number))

    const durationSeconds = Math.round((Date.now() - startMs) / 1000)

    return {
      handoff_version: '1.0',
      source_agent: 'WRITER',
      source_node_id: node.node_id,
      target_agent: 'REVIEWER',
      run_id: node.run_id,
      output: output as WriterOutput['output'],
      assumptions_made: (p['assumptions_made'] as string[]) ?? [],
      execution_meta: {
        llm_used: modelUsed,
        tokens_input: tokensIn,
        tokens_output: tokensOut,
        duration_seconds: durationSeconds,
        retries,
      },
      lateral_delegation_request: null,
    }
  }
}
