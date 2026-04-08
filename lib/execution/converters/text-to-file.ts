// lib/execution/converters/text-to-file.ts
// Phase A text-to-file converters: transforms WRITER LLM output into downloadable
// file bytes for formats txt, csv, json, yaml, html, md, and code (py/ts/js/sh).
// Phase B formats (docx, pdf) are stubs — implemented in mf-phase7.
//
// Spec: multi-format-artifact-output.feature.md Part 1 §1.6

import { buildFilename, sanitizeCsvFormulas } from '@/lib/execution/converters/sanitize'

export type OutputFileFormat =
  | 'txt'
  | 'csv'
  | 'json'
  | 'yaml'
  | 'html'
  | 'md'
  | 'py'
  | 'ts'
  | 'js'
  | 'sh'
  | 'docx'  // Phase B — implemented in mf-phase7
  | 'pdf'   // Phase B — implemented in mf-phase7

export const MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

// ─── Fence stripper ──────────────────────────────────────────────────────────

/**
 * Strip accidental markdown code fences from the start and end of LLM output.
 * Handles: ```json, ```csv, ``` etc.
 */
export function stripMarkdownFences(content: string): string {
  return content
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim()
}

// ─── MIME type map ───────────────────────────────────────────────────────────

const MIME_MAP: Record<Exclude<OutputFileFormat, 'docx' | 'pdf'>, string> = {
  txt:  'text/plain',
  csv:  'text/csv',
  json: 'application/json',
  yaml: 'text/yaml',
  html: 'text/html',
  md:   'text/markdown',
  py:   'text/plain',
  ts:   'text/plain',
  js:   'text/plain',
  sh:   'text/plain',
}

// ─── Converter ───────────────────────────────────────────────────────────────

/**
 * Convert WRITER LLM text output into file bytes for the given format.
 *
 * @param content  Raw LLM output string (may include markdown fences for some formats).
 * @param format   Target OutputFileFormat.
 * @param slug     Human-readable slug for filename generation (e.g. node description).
 * @returns        { bytes, filename, mimeType } ready for RunArtifact persistence.
 * @throws         Error for Phase B formats (docx/pdf) that are not yet implemented.
 * @throws         Error if bytes exceed MAX_ARTIFACT_SIZE_BYTES (checked by validateArtifact).
 */
export async function convertToFile(
  content: string,
  format: OutputFileFormat,
  slug: string,
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  const filename = buildFilename(slug, format)

  switch (format) {
    case 'txt': {
      const data = stripMarkdownFences(content)
      return { bytes: Buffer.from(data, 'utf-8'), filename, mimeType: MIME_MAP.txt }
    }

    case 'md': {
      // Markdown: preserve fences — they are intentional formatting
      return { bytes: Buffer.from(content, 'utf-8'), filename, mimeType: MIME_MAP.md }
    }

    case 'csv': {
      const stripped = stripMarkdownFences(content)
      const sanitized = sanitizeCsvFormulas(stripped)
      return { bytes: Buffer.from(sanitized, 'utf-8'), filename, mimeType: MIME_MAP.csv }
    }

    case 'json': {
      const stripped = stripMarkdownFences(content)
      // Validate and canonicalise JSON (throws SyntaxError on invalid JSON)
      const parsed = JSON.parse(stripped)
      const canonical = JSON.stringify(parsed, null, 2)
      return { bytes: Buffer.from(canonical, 'utf-8'), filename, mimeType: MIME_MAP.json }
    }

    case 'yaml': {
      const stripped = stripMarkdownFences(content)
      return { bytes: Buffer.from(stripped, 'utf-8'), filename, mimeType: MIME_MAP.yaml }
    }

    case 'html': {
      // HTML: no fence stripping — the full HTML document is expected
      return { bytes: Buffer.from(content, 'utf-8'), filename, mimeType: MIME_MAP.html }
    }

    case 'py':
    case 'ts':
    case 'js':
    case 'sh': {
      const stripped = stripMarkdownFences(content)
      return { bytes: Buffer.from(stripped, 'utf-8'), filename, mimeType: MIME_MAP[format] }
    }

    case 'docx': {
      const { markdownToDocx } = await import('./to-docx')
      const bytes = await markdownToDocx(content)
      return {
        bytes,
        filename,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }
    }

    case 'pdf': {
      const { markdownToPdf } = await import('./to-pdf')
      const bytes = await markdownToPdf(content)
      return { bytes, filename, mimeType: 'application/pdf' }
    }

    default: {
      // Exhaustiveness check
      const _: never = format
      throw new Error(`Unknown output format: "${String(_)}"`)
    }
  }
}
