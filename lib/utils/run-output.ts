// lib/utils/run-output.ts
// Shared helper for extracting a plaintext summary from a completed node's handoff_out.
// Used by API routes and server-side page components.

/** Extract a short plaintext summary from a completed node's handoff_out. */
export function extractOutputSummary(handoffOut: unknown): string | null {
  if (!handoffOut || typeof handoffOut !== 'object') return null
  const h = handoffOut as Record<string, unknown>
  // Reviewer formatted_content takes priority
  if (typeof h['formatted_content'] === 'string' && h['formatted_content']) {
    return h['formatted_content'].slice(0, 2000)
  }
  const output = h['output'] as Record<string, unknown> | undefined
  if (!output) return null
  const summary = output['summary'] as string | undefined
  const content = (output['content'] ?? output['text']) as string | undefined
  if (summary) return summary.slice(0, 500)
  if (content) return content.slice(0, 2000)
  return null
}
