// lib/execution/converters/validate.ts
// Post-conversion artifact validation before persistence.
// Checks size, JSON validity, and CSV column consistency.
// Spec: multi-format-artifact-output.feature.md Part 1 §1.7

import { MAX_ARTIFACT_SIZE_BYTES, type OutputFileFormat } from '@/lib/execution/converters/text-to-file'

/**
 * Validate converted artifact bytes before writing to the database.
 *
 * Checks:
 *   1. Size ≤ 10 MB (MAX_ARTIFACT_SIZE_BYTES).
 *   2. JSON: content must be parseable.
 *   3. CSV: all non-empty lines must have the same number of comma-separated columns.
 *
 * @throws Error on any validation failure.
 */
export function validateArtifact(bytes: Buffer, format: OutputFileFormat): void {
  if (bytes.byteLength > MAX_ARTIFACT_SIZE_BYTES) {
    throw new Error(
      `Artifact exceeds 10 MB limit (${bytes.byteLength} bytes)`,
    )
  }

  if (format === 'json') {
    // Throws SyntaxError on invalid JSON
    JSON.parse(bytes.toString('utf-8'))
  }

  if (format === 'csv') {
    const lines = bytes.toString('utf-8').split('\n').filter(Boolean)
    if (lines.length > 1) {
      const firstLine = lines[0]
      if (firstLine === undefined) return
      const colCount = firstLine.split(',').length
      const badLine = lines.findIndex((l, i) => i > 0 && l.split(',').length !== colCount)
      if (badLine > 0) {
        throw new Error(`CSV: inconsistent column count at line ${badLine + 1}`)
      }
    }
  }
}
