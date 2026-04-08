// lib/execution/converters/to-docx.ts
// Converts a Markdown string to a .docx Buffer using remark-docx.
//
// Spec: mf-phase7-docx-pdf-converters

import { unified }    from 'unified'
import remarkParse  from 'remark-parse'
import remarkDocx   from 'remark-docx'

import { MAX_ARTIFACT_SIZE_BYTES } from './text-to-file'

/**
 * Convert Markdown text to a .docx Buffer.
 *
 * @param markdown   Raw Markdown string (LLM output).
 * @returns          A Buffer containing the OOXML .docx bytes.
 * @throws           Error if the generated file exceeds MAX_ARTIFACT_SIZE_BYTES.
 */
export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkDocx)

  const file = await processor.process(markdown)

  // remark-docx compile result is Promise<ArrayBuffer>
  const arrayBuffer = await (file.result as Promise<ArrayBuffer>)
  const buf = Buffer.from(arrayBuffer)

  if (buf.byteLength > MAX_ARTIFACT_SIZE_BYTES) {
    throw new Error('Generated .docx exceeds 10 MB limit.')
  }

  return buf
}
