---
title: "MF-Phase7 — Phase B converters: Markdown → DOCX + PDF (remark-docx)"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md#part-1
depends_on: [mf-phase2-converters-writer]
created: 2026-04-08
status: todo
round: 5
branch: feat/mf-phase7-docx-pdf-converters
---

## Objectif

Implémenter les converters Phase B :
- `markdownToDocx()` via `remark-docx` (v0.3.26, MIT) — Markdown AST → `.docx` natif Microsoft Office
- `markdownToPdf()` via `remark-pdf` — déféré Phase B-2 (implémenter si disponible, sinon placeholder)

Ces converters s'intègrent dans le switch de `convertToFile()` créé en MF-Phase2.

---

## Prérequis

`feat/mf-phase2-converters-writer` mergé : `convertToFile()`, `OutputFileFormat`, `MAX_ARTIFACT_SIZE_BYTES` existants.

---

## Spec de référence

- **Part 1 §1.9** — remark-docx, implémentation 3 lignes, capacités supportées

---

## Installation packages

```bash
npm install remark-docx remark-parse unified
# remark-pdf déféré — installer seulement si le package est disponible et stable
```

Vérifier après install :
```bash
npx tsc --noEmit   # aucune régression de types
```

---

## Fichiers à créer / modifier

### 1. `lib/execution/converters/to-docx.ts` — NOUVEAU

```ts
import { unified }      from 'unified'
import remarkParse      from 'remark-parse'
import remarkDocx       from 'remark-docx'

/**
 * Convert Markdown text to a Word document (.docx).
 *
 * Uses remark-docx (MIT, v0.3.26+) which maps the full Markdown AST
 * to native docx elements via the `docx` library.
 *
 * Supported features:
 *   headings, paragraphs, bold/italic/code, lists, tables,
 *   blockquotes, code blocks (syntax highlight via shiki),
 *   images (base64 embedded), footnotes, math (MathJax).
 *
 * Non-blocking: remark-docx is async but runs in the same V8 thread;
 * no worker_threads needed (< 100ms for 10-page document).
 * Hard limit: MAX_ARTIFACT_SIZE_BYTES (10 MB).
 */
export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkDocx, { output: 'buffer' })

  const file = await processor.process(markdown)
  const buf  = Buffer.from(file.result as ArrayBuffer)

  if (buf.byteLength > 10 * 1024 * 1024) {
    throw new Error('Generated .docx exceeds 10 MB limit.')
  }

  return buf
}
```

### 2. `lib/execution/converters/to-pdf.ts` — NOUVEAU (Phase B-2)

```ts
/**
 * Convert Markdown text to PDF.
 *
 * Phase B-2 — deferred pending remark-pdf stability.
 * Fallback: the browser Print button in ResultTab already produces a
 * quality PDF via window.print() — use that until this is implemented.
 */
export async function markdownToPdf(_markdown: string): Promise<Buffer> {
  throw new Error(
    'PDF export is not yet implemented. ' +
    'Use the Print button in the Result tab to export as PDF.'
  )
}
```

### 3. `lib/execution/converters/text-to-file.ts`

Décommenter / compléter le switch pour `'docx'` et `'pdf'` :

```ts
// Dans convertToFile() switch, remplacer les throw Phase B placeholders :
case 'docx': {
  const { markdownToDocx } = await import('./to-docx')
  const bytes = await markdownToDocx(content)
  return {
    bytes,
    filename: buildFilename(slug, 'docx'),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
}
case 'pdf': {
  const { markdownToPdf } = await import('./to-pdf')
  const bytes = await markdownToPdf(content)
  return {
    bytes,
    filename: buildFilename(slug, 'pdf'),
    mimeType: 'application/pdf',
  }
}
```

### 4. Tests — `tests/execution/converters/to-docx.test.ts` — NOUVEAU

```ts
import { markdownToDocx } from '@/lib/execution/converters/to-docx'

describe('markdownToDocx', () => {
  it('converts simple markdown to non-empty Buffer', async () => {
    const buf = await markdownToDocx('# Hello\n\nParagraph text.')
    expect(buf.byteLength).toBeGreaterThan(0)
    // .docx is a ZIP — check magic bytes PK\x03\x04
    expect(buf[0]).toBe(0x50)   // P
    expect(buf[1]).toBe(0x4b)   // K
  })

  it('converts table', async () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |'
    const buf = await markdownToDocx(md)
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  it('throws if result > 10 MB', async () => {
    // Mocker unified pour retourner un ArrayBuffer > 10MB
    // ...
  })
})
```

---

## Critères de validation

- [ ] `npm install remark-docx remark-parse unified` réussit
- [ ] `markdownToDocx('# Test\n\nHello')` retourne un `Buffer` dont les 2 premiers bytes sont `0x50 0x4b` (magic bytes ZIP/DOCX)
- [ ] Le `.docx` généré s'ouvre correctement dans Microsoft Word et LibreOffice
- [ ] `convertToFile('# Title', 'docx', 'test')` ne throw plus
- [ ] `convertToFile('# Title', 'pdf', 'test')` throw avec message clair sur Phase B-2
- [ ] `npx tsc --noEmit` zéro erreur
- [ ] Tests `to-docx.test.ts` verts

---

## Commit

```
feat(converters): Phase B — Markdown to DOCX via remark-docx

- npm: install remark-docx remark-parse unified
- lib/execution/converters/to-docx.ts: markdownToDocx() via remark-docx
- lib/execution/converters/to-pdf.ts: Phase B-2 placeholder with clear error
- lib/execution/converters/text-to-file.ts: activate docx/pdf cases in switch
- tests/execution/converters/to-docx.test.ts
```
