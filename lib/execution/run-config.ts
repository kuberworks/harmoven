// lib/execution/run-config.ts
// Typed interface for the run configuration passed to the executor.
// See also: llm-tool-use-web-search.feature.md §4.1 for enable_web_search field.
import { z } from 'zod'

const OUTPUT_FILE_FORMAT = z.enum([
  'txt', 'csv', 'json', 'yaml', 'html', 'md',
  'py', 'ts', 'js', 'sh',
  'docx', 'pdf',
])

export const RunConfigSchema = z.object({
  enable_web_search:  z.boolean().optional().default(false),
  /**
   * C2 rule: when set, overrides any desired_outputs from the CLASSIFIER.
   * This is the explicit "form selector" value chosen by the user before run creation.
   */
  output_file_format: OUTPUT_FILE_FORMAT.optional(),
})

export type RunConfig = z.infer<typeof RunConfigSchema>

export function parseRunConfig(raw: unknown): RunConfig {
  const result = RunConfigSchema.safeParse(raw ?? {})
  return result.success ? result.data : { enable_web_search: false }
}
