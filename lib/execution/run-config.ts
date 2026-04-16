// lib/execution/run-config.ts
// Typed interface for the run configuration passed to the executor.
// See also: llm-tool-use-web-search.feature.md §4.1 for enable_web_search field.
import { z } from 'zod'

const OUTPUT_FILE_FORMAT = z.enum([
  'txt', 'csv', 'json', 'yaml', 'html', 'md',
  'py', 'ts', 'js', 'sh',
  'docx', 'pdf',
])

/**
 * Per-agent LLM profile overrides.
 * When a key is present, the executor injects preferred_llm into the node metadata
 * so DirectLLMClient prioritises that profile via selectLlm(preferredLlmId).
 * Absent / undefined key = Auto (system picks based on tier + task constraints).
 * Only PLANNER, WRITER, REVIEWER are user-configurable; CLASSIFIER is always fast.
 * .strict() rejects unknown agent keys (e.g. CLASSIFIER, PYTHON_EXECUTOR).
 */
export const LlmOverridesSchema = z.object({
  PLANNER:  z.string().max(128).optional(),
  WRITER:   z.string().max(128).optional(),
  REVIEWER: z.string().max(128).optional(),
}).strict()

export type LlmOverrides = z.infer<typeof LlmOverridesSchema>

export const RunConfigSchema = z.object({
  enable_web_search:       z.boolean().optional().default(false),
  web_search_provider:     z.enum(['brave', 'tavily', 'duckduckgo']).optional(),
  web_search_max_results:  z.number().int().min(1).max(10).optional(),
  /**
   * C2 rule: when set, overrides any desired_outputs from the CLASSIFIER.
   * This is the explicit "form selector" value chosen by the user before run creation.
   */
  output_file_format: OUTPUT_FILE_FORMAT.optional(),
  /** Per-agent LLM override. See LlmOverridesSchema above. */
  llm_overrides: LlmOverridesSchema.optional(),
})

export type RunConfig = z.infer<typeof RunConfigSchema>

export function parseRunConfig(raw: unknown): RunConfig {
  const result = RunConfigSchema.safeParse(raw ?? {})
  return result.success ? result.data : { enable_web_search: false }
}
