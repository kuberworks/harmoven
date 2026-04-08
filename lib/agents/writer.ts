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
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

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
  /** When set, the Writer is instructed to output raw format content (no fences/prose). */
  output_file_format?: string
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
    tool_calls_trace?: import('@/lib/llm/interface').ToolCallIteration[]
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
 * Defaults are set close to the maximum modern providers accept (most cap at 64k).
 * Override via orchestrator.yaml:
 *   writer:
 *     max_tokens_low:    8192
 *     max_tokens_medium: 32768
 *     max_tokens_high:   65536
 */
const DEFAULT_MAX_TOKENS: Record<Complexity, number> = {
  low:    8_192,
  medium: 32_768,
  high:   65_536,
}

interface WriterOrchestratorConfig {
  max_tokens_low?:    number
  max_tokens_medium?: number
  max_tokens_high?:   number
}

function loadWriterConfig(): WriterOrchestratorConfig {
  try {
    const yamlPath = path.resolve(process.cwd(), 'orchestrator.yaml')
    const raw = fs.readFileSync(yamlPath, 'utf8')
    const config = yaml.load(raw) as Record<string, unknown> | null
    return (config?.['writer'] as WriterOrchestratorConfig | undefined) ?? {}
  } catch {
    return {}
  }
}

// Loaded once at module init (process lifetime in prod; per-test in Jest)
const _writerConfig = loadWriterConfig()

const MAX_TOKENS: Record<Complexity, number> = {
  low:    _writerConfig.max_tokens_low    ?? DEFAULT_MAX_TOKENS.low,
  medium: _writerConfig.max_tokens_medium ?? DEFAULT_MAX_TOKENS.medium,
  high:   _writerConfig.max_tokens_high   ?? DEFAULT_MAX_TOKENS.high,
}

/**
 * Profiles that produce code/data output need extra headroom because the LLM
 * JSON-encodes special characters, inflating token usage by ~30-40%.
 */
const CODE_PROFILES = new Set<ProfileId>([
  'app_scaffolding', 'data_reporting', 'finance_modeling',
])

function maxTokensFor(complexity: Complexity, profile: ProfileId): number {
  const base = MAX_TOKENS[complexity]
  // Code profiles get 2× headroom (capped at 131 072 — above current provider maximums,
  // so the provider's own hard limit applies before ours).
  return CODE_PROFILES.has(profile) ? Math.min(base * 2, 131_072) : base
}

// ─── System prompt ────────────────────────────────────────────────────────────

/**
 * Build a structured-output instruction suffix for WRITER nodes that specify
 * an explicit `output_file_format`. Instructs the LLM to output raw format
 * content only — no markdown fences, no prose preamble.
 *
 * Spec: multi-format-artifact-output.feature.md Part 1 §1.5
 */
export function buildWriterSystemPrompt(format?: string): string {
  if (!format) return ''
  const descriptions: Record<string, string> = {
    txt:  'plain text',
    csv:  'CSV — first line is the header, comma-separated, no markdown',
    json: 'JSON — valid, parseable JSON object or array',
    yaml: 'YAML — valid YAML document',
    html: 'HTML — complete <html>…</html> document with <head> and <body>',
    md:   'Markdown document',
    py:   'Python source code',
    ts:   'TypeScript source code',
    js:   'JavaScript source code',
    sh:   'shell script',
    docx: 'document content (plain text / Markdown)',
    pdf:  'document content (plain text / Markdown)',
  }
  const desc = descriptions[format] ?? format
  const firstChar: Record<string, string> = {
    csv:  'the header row',
    json: '{ or [',
    yaml: 'the first key',
    html: '<!DOCTYPE html> or <html>',
    py:   'the first line of code (import, def, or a comment)',
    ts:   'the first line of code',
    js:   'the first line of code',
    sh:   '#!/bin/sh or the first command',
  }
  const start = firstChar[format] ?? 'the first word of the content'
  return (
    `\n\nOUTPUT INSTRUCTIONS: Output ONLY raw ${desc} content. ` +
    `No markdown code fences. No preamble. No prose before or after the content. ` +
    `Start your response with ${start}.`
  )
}

function buildSystemPrompt(profile: ProfileId, isPythonCodeNode: boolean): string {
  const basePrompt = `\
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
- Output ONLY the JSON object. No markdown fence, no prose around the JSON.
- assumptions_made: list every decision you made that was not explicit in the task.
- confidence < 80 means the output needs revision.
- FORMATTING — output.content for prose/document/data nodes (not python_code):
  • DEFAULT FORMAT IS MARKDOWN — use it unless the task explicitly requests another format.
  • Use # / ## / ### headings to structure the response.
  • Use **bold** and *italic* for emphasis.
  • Use bullet lists (- item) or numbered lists (1. item) where appropriate.
  • Use \`inline code\` for short code snippets, file names, values.
  • Use fenced code blocks (\`\`\`language … \`\`\`) for multi-line code or data.
  • Use > blockquotes for callouts, warnings, important notes.
  • Never return a wall of unstructured plain text — always structure the content.
  • NEVER produce HTML (tags like <div>, <p>, <ul>, <h1>, etc.) unless the task
    description explicitly says "HTML", "web page", or "HTML document".
    If the user asked for a document, report, or content → use Markdown, not HTML.`

  if (!isPythonCodeNode) return basePrompt

  return basePrompt + `

CRITICAL — This is a python_code node that feeds a PYTHON_EXECUTOR:
- output.type MUST be "code".
- output.content MUST be complete, self-contained, executable Python source code — nothing else.
- Do NOT write prose, descriptions, JSON structures, or markdown in output.content.
- The Python code MUST save every file to disk using the appropriate library call:
  openpyxl: workbook.save('filename.xlsx')
  pandas:   df.to_csv('filename.csv', index=False)  or  df.to_excel('filename.xlsx', index=False)
  matplotlib: plt.savefig('filename.png', dpi=150, bbox_inches='tight')
  NOTE — do NOT call matplotlib.use('Agg') or plt.switch_backend(): the platform
  sets MPLBACKEND=Agg automatically before execution. Calling it explicitly is a no-op
  at best and may emit warnings.
  reportlab: canvas.save()  or  doc.build(story)
  project files: os.makedirs('path/to/dir', exist_ok=True) then open('path/to/file.ext', 'w').write(content)
- For project scaffolds (source code projects with multiple files) — two valid patterns:
  PREFERRED: create each file individually using open(),  preserving directory paths.
    os.makedirs('hello-world/src/main/java/com/example', exist_ok=True)
    open('hello-world/src/main/java/com/example/App.java', 'w').write('...')
    open('hello-world/README.md', 'w').write('...')
  ALSO ACCEPTABLE: use Python's zipfile module. The platform auto-extracts any .zip
    file BEFORE collecting artifacts, so every file inside — README.md, pom.xml, etc.
    — is collected individually and the REVIEWER can inspect each one.
    Do NOT mix both patterns: do not create a zip AND also write loose files.
- File names must use only letters, digits, dots, hyphens, underscores, and forward slashes
  for subdirectory paths (e.g. 'src/main/java/App.java'). No spaces, no accents.
- The code runs in Pyodide (Python 3.11 WASM). All standard library modules are available.
  Popular packages (openpyxl, pandas, matplotlib, plotly, seaborn, reportlab, Pillow, scipy,
  scikit-learn, networkx) are auto-installed on demand.
- Do not include any top-level async code; use synchronous code only.
- UNAVAILABLE in this runtime — NEVER generate code that uses these libraries:
    torch, tensorflow, keras, jax           — no CUDA/native binaries in WASM
    pydub, moviepy, ffmpeg-python           — require the ffmpeg binary (not present)
    psycopg2, asyncpg                       — require native libpq
    grpcio                                  — requires native bindings + TCP
    tkinter, PyQt5, wx                      — GUI toolkits, no display
    multiprocessing.Pool, subprocess        — fork/exec not available in WASM
  If the user's task requires one of these libraries, output a Python script that
  raises RuntimeError with a clear explanation rather than silently failing.
- Do NOT output JSON that describes what the file contains — output only the Python code.`
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
      { role: 'system' as const, content: buildSystemPrompt(node.domain_profile, node.expected_output_type === 'python_code') + buildWriterSystemPrompt(node.output_file_format) },
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
    let toolCallsTrace: import('@/lib/llm/interface').ToolCallIteration[] | undefined

    if (onChunk) {
      // Streaming does not retry (chunks already emitted to client)
      const result = await this.llm.stream(messages, { model: tier, maxTokens: maxTokensFor(node.complexity, node.domain_profile), signal }, onChunk)
      raw = result.content
      tokensIn = result.tokensIn
      tokensOut = result.tokensOut
      costUsd = result.costUsd ?? 0
      modelUsed = result.model
      toolCallsTrace = result.tool_calls_trace
    } else {
      const result = await withRetry(
        () => this.llm.chat(messages, { model: tier, maxTokens: maxTokensFor(node.complexity, node.domain_profile), signal }),
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
      toolCallsTrace = result.tool_calls_trace
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
      // M-3 fix: never log the raw LLM response — it may contain PII or confidential
      // content from task_input. Log only a structural fingerprint for debugging.
      const contentHash = createHash('sha256').update(raw).digest('hex').slice(0, 12)
      console.error(
        `[Writer(${node.node_id})] LLM returned invalid JSON — ` +
        `length=${raw.length} sha256_prefix=${contentHash}`,
      )
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
        ...(toolCallsTrace?.length ? { tool_calls_trace: toolCallsTrace } : {}),
      },
      lateral_delegation_request: null,
    }
  }
}
