'use client'
// components/run/MarkdownContent.tsx
// Wrapper around react-markdown + remark-gfm + rehype-sanitize.
// Intended to be loaded via next/dynamic so the markdown parser bundle (~80 KB)
// is code-split out of the initial JS chunk for the run detail page.

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

// rehype-sanitize schema: default allowlist, no iframes, no forms, no scripts.
// javascript: URLs stripped automatically by the default schema.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': (defaultSchema.attributes?.['*'] ?? []).filter(
      (a) => typeof a !== 'string' || !a.startsWith('on')
    ),
  },
}

export default function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}>
      {children}
    </ReactMarkdown>
  )
}
