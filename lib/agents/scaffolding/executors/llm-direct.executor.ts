// lib/agents/scaffolding/executors/llm-direct.executor.ts
// LLMDirectExecutor — default layer agent backend (Am.72.3).
//
// Calls an ILLMClient with the layer spec + context files.
// Parses the JSON response, writes produced files to the worktree.
// Always available — no external dependencies beyond the configured LLM.
//
// SECURITY:
//   - File paths from LLM output are sanitized: no absolute paths, no ".." traversal,
//     no null bytes. Defence-in-depth: the joined path is re-verified to stay inside
//     the worktree_path before writing (mirrors the assertWorktreeIsSafe() pattern
//     from repair.agent.ts / smoke-test.agent.ts).
//   - Context file content is truncated at MAX_CONTEXT_CHARS to prevent prompt injection
//     via arbitrarily large context files.
//   - LLM output is capped at MAX_OUTPUT_CHARS to reject hallucinated oversized responses.

import fs   from 'fs'
import path from 'path'

import type { ILLMClient }         from '@/lib/llm/interface'
import type {
  ILayerAgentExecutor,
  LayerAgentInput,
  LayerAgentOutput,
}                                  from '../layer-agent-executor.interface'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * LLM tier per layer — mirrors model selection in Section 24.3.
 * db / infra → fast (haiku): structured output, small context.
 * api / ui / test → balanced (sonnet): reasoning + code generation.
 */
const LAYER_TIER: Record<string, string> = {
  db:    'fast',
  infra: 'fast',
  api:   'balanced',
  ui:    'balanced',
  test:  'balanced',
}

/** Max characters read from a single context file (prevents prompt injection via huge files). */
const MAX_CONTEXT_CHARS = 200_000

/** Max characters accepted in LLM output (rejects hallucinated oversized responses). */
const MAX_OUTPUT_CHARS = 200_000

/** Max tokens requested from the LLM — enough for multi-file output. */
const MAX_TOKENS = 8_000

// ─── Internal types ───────────────────────────────────────────────────────────

interface LLMFile {
  path:    string
  content: string
}

interface LLMLayerResponse {
  files:    LLMFile[]
  summary:  string
  cost_usd: number
}

// ─── Security: path sanitization ──────────────────────────────────────────────

/**
 * Validate a relative file path returned by the LLM.
 * Throws if the path is absolute, contains ".." traversal, or has null bytes.
 * Returns the path.normalize()-d safe path.
 */
function sanitizeRelativePath(p: string): string {
  if (p.includes('\0')) {
    throw new Error(`[LLMDirectExecutor] Null byte in file path — rejected`)
  }
  if (path.isAbsolute(p)) {
    throw new Error(
      `[LLMDirectExecutor] LLM returned absolute path: "${p}" — rejected (must be relative)`,
    )
  }
  const normalized = path.normalize(p)
  if (normalized.startsWith('..')) {
    throw new Error(
      `[LLMDirectExecutor] LLM returned path-traversal path: "${p}" — rejected`,
    )
  }
  return normalized
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadContextFiles(contextFiles: string[]): string {
  const parts: string[] = []
  for (const filePath of contextFiles) {
    try {
      const raw      = fs.readFileSync(filePath, 'utf8')
      const content  = raw.length > MAX_CONTEXT_CHARS
        ? raw.slice(0, MAX_CONTEXT_CHARS) + '\n[…truncated]'
        : raw
      parts.push(`### ${path.basename(filePath)}\n\`\`\`\n${content}\n\`\`\``)
    } catch {
      // Context file not readable (deleted, wrong path) — skip, don't abort the layer
    }
  }
  return parts.join('\n\n')
}

function buildSystemPrompt(): string {
  return `\
You are a Harmoven Layer Agent. Your job is to implement a software layer
according to the provided specification.

Respond ONLY with a single valid JSON object — no markdown fences, no prose,
no commentary outside the JSON object.

Schema:
{
  "files": [
    { "path": "<relative path from project root>", "content": "<complete file content>" }
  ],
  "summary": "<one sentence describing what you implemented>",
  "cost_usd": 0
}

Rules:
  - "path" must be relative (no leading /), no ".." segments, no null bytes.
  - "content" must be the complete file content — never truncated or elided.
  - Include ALL files required by the spec. An empty "files" array is allowed
    only if the spec requires no file changes.
  - "cost_usd" is always 0 — cost is tracked externally.`
}

function buildUserPrompt(input: LayerAgentInput, contextContent: string): string {
  const contextSection = contextContent.length > 0
    ? `\n\n## Context files\n${contextContent}`
    : ''

  return `\
## Layer: ${input.layer}
## Budget: $${input.budget_usd.toFixed(2)}
## Run: ${input.run_id} / Node: ${input.node_id}

## Specification
${input.spec}${contextSection}`
}

function parseLayerResponse(raw: string): LLMLayerResponse {
  const trimmed = raw.trim()

  if (trimmed.length > MAX_OUTPUT_CHARS) {
    throw new Error(
      `[LLMDirectExecutor] LLM output too large (${trimmed.length} chars, max ${MAX_OUTPUT_CHARS}) — possible hallucination`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    throw new Error(
      `[LLMDirectExecutor] LLM response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (
    typeof parsed !== 'object'
    || parsed === null
    || !Array.isArray((parsed as Record<string, unknown>).files)
  ) {
    throw new Error('[LLMDirectExecutor] LLM response missing required "files" array')
  }

  return parsed as LLMLayerResponse
}

/**
 * Write files produced by the LLM into the worktree.
 * Each file path is sanitized + verified to stay within the worktree.
 * Returns the list of relative paths actually written.
 */
function writeFilesToWorktree(files: LLMFile[], worktreePath: string): string[] {
  const resolvedWorktree = path.resolve(worktreePath)
  const created: string[] = []

  for (const file of files) {
    const safeName  = sanitizeRelativePath(file.path)
    const fullPath  = path.join(resolvedWorktree, safeName)

    // Defence-in-depth: verify joined path is still inside worktree
    const resolved = path.resolve(fullPath)
    if (
      !resolved.startsWith(resolvedWorktree + path.sep)
      && resolved !== resolvedWorktree
    ) {
      throw new Error(
        `[LLMDirectExecutor] File path escapes worktree: "${file.path}" → "${resolved}"`,
      )
    }

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, file.content, 'utf8')
    created.push(safeName)
  }

  return created
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export class LLMDirectExecutor implements ILayerAgentExecutor {
  readonly name = 'llm_direct' as const

  constructor(private readonly llm: ILLMClient) {}

  async isAvailable(): Promise<boolean> {
    return true  // always available — depends only on the injected ILLMClient
  }

  async execute(input: LayerAgentInput): Promise<LayerAgentOutput> {
    const start = Date.now()

    try {
      const contextContent = loadContextFiles(input.context_files)
      const tier           = LAYER_TIER[input.layer] ?? 'balanced'

      const result = await this.llm.chat(
        [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user',   content: buildUserPrompt(input, contextContent) },
        ],
        { model: tier, maxTokens: MAX_TOKENS },
      )

      const parsed  = parseLayerResponse(result.content)
      const created = writeFilesToWorktree(parsed.files, input.worktree_path)

      return {
        success:        true,
        files_modified: [],
        files_created:  created,
        tests_passed:   null,           // LLMDirectExecutor doesn't run tests
        cost_usd:       0,              // tracked externally via token counts
        duration_ms:    Date.now() - start,
        raw_output:     result.content,
      }
    } catch (err) {
      return {
        success:        false,
        files_modified: [],
        files_created:  [],
        tests_passed:   null,
        cost_usd:       0,
        duration_ms:    Date.now() - start,
        raw_output:     '',
        error:          err instanceof Error ? err.message : String(err),
      }
    }
  }
}
