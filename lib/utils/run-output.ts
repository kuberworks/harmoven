// lib/utils/run-output.ts
// Shared helper for extracting a plaintext summary from a completed node's handoff_out.
// Used by API routes and server-side page components.

/** Extract a short plaintext summary from a completed node's handoff_out. */
export function extractOutputSummary(handoffOut: unknown): string | null {
  if (!handoffOut || typeof handoffOut !== 'object') return null
  const h = handoffOut as Record<string, unknown>

  // REVIEWER: prefer overall_confidence_rationale — it is a purposefully-written
  // one-sentence summary, not a raw document slice.  Fall back to the first
  // sentence of formatted_content only when rationale is absent.
  if (typeof h['verdict'] === 'string') {
    const rationale = typeof h['overall_confidence_rationale'] === 'string'
      ? (h['overall_confidence_rationale'] as string).trim()
      : null
    if (rationale) return rationale.slice(0, 500)

    // formatted_content is the full Markdown doc — extract first sentence only
    if (typeof h['formatted_content'] === 'string' && h['formatted_content']) {
      const text = (h['formatted_content'] as string).trim().slice(0, 600)
      const sentenceEnd = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'))
      return sentenceEnd > 30 ? text.slice(0, sentenceEnd + 1) : text
    }
  }

  // WRITER / PYTHON_EXECUTOR: content lives under output.*
  const output = h['output'] as Record<string, unknown> | undefined
  if (output) {
    const summary = output['summary'] as string | undefined
    const content = (output['content'] ?? output['text']) as string | undefined
    if (summary) return summary.slice(0, 500)
    if (content) {
      const text = (content as string).trim().slice(0, 600)
      const sentenceEnd = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'))
      return sentenceEnd > 30 ? text.slice(0, sentenceEnd + 1) : text
    }
  }

  return null
}
