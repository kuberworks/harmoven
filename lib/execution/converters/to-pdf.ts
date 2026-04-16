// lib/execution/converters/to-pdf.ts
// Phase B-2 placeholder — PDF generation is not yet implemented server-side.
//
// Spec: mf-phase7-docx-pdf-converters (Phase B-2, future task)

/**
 * Convert Markdown text to a PDF Buffer.
 *
 * @throws Always — PDF export is not yet implemented server-side.
 *         Use the Print button in the Result tab to export as PDF.
 */
export async function markdownToPdf(_markdown: string): Promise<Buffer> {
  throw new Error(
    'PDF export is not yet implemented. ' +
    'Use the Print button in the Result tab to export as PDF.',
  )
}
