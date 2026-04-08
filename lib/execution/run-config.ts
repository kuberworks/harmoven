// lib/execution/run-config.ts
// Typed interface for the run configuration passed to the executor.
// See also: llm-tool-use-web-search.feature.md §4.1 for enable_web_search field.
import { z } from 'zod'

export const RunConfigSchema = z.object({
  enable_web_search: z.boolean().optional().default(false),
})

export type RunConfig = z.infer<typeof RunConfigSchema>

export function parseRunConfig(raw: unknown): RunConfig {
  const result = RunConfigSchema.safeParse(raw ?? {})
  return result.success ? result.data : { enable_web_search: false }
}
