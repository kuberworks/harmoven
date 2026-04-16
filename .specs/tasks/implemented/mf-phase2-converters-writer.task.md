---
title: "MF-Phase2 — Converters + structured WRITER mode (Phase A formats)"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md#part-1
depends_on: [mf-phase1-schema-plumbing]
created: 2026-04-08
status: todo
round: 2
branch: feat/mf-phase2-converters-writer
---

## Objectif

Implémenter le pipeline de conversion d'artifacts texte → fichiers téléchargeables (formats Phase A).
Modifier WRITER pour qu'il génère un output structuré quand `output_file_format` est présent.

---

## Prérequis

Branche `feat/mf-phase1-schema-plumbing` mergée dans `develop`.

---

## Spec de référence

- **Part 1 §1.4** — formule `desired_outputs` → `OutputFileFormat` enum
- **Part 1 §1.5** — WRITER structured mode + `buildWriterSystemPrompt()`
- **Part 1 §1.6** — `convertWriterOutput()` pipeline
- **Part 1 §1.7** — `validateArtifact()`
- **Part 1 §1.8** — artifact_role C3/C4 edge cases (PYTHON_EXECUTOR + WRITER sans REVIEWER)
- **Part 1 §1.8a** — C3: `supplementary`, C4: auto-promotion à COMPLETED
- **Part 1 §1.9** — converters Phase A (txt, csv, json, yaml, html, code)

---

## Fichiers à créer / modifier

### 1. `lib/execution/converters/text-to-file.ts` — NOUVEAU

Phase A converters. Chaque converter :
- Prend `content: string` (output WRITER)
- Retourne `{ bytes: Buffer, filename: string, mimeType: string }`
- Appelle `buildFilename()` depuis `sanitize.ts` (Phase 4)
- Applique `sanitizeCsvFormulas()` pour le format CSV
- Max 10 MB (`MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024`)

```ts
export type OutputFileFormat =
  | 'txt' | 'csv' | 'json' | 'yaml' | 'html' | 'md'
  | 'py' | 'ts' | 'js' | 'sh'
  | 'docx'  // Phase B — implémenté dans mf-phase7
  | 'pdf'   // Phase B — implémenté dans mf-phase7

export const MAX_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024

// Striper les fences markdown accidentels (``` au début/fin)
export function stripMarkdownFences(content: string): string {
  return content
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim()
}

export async function convertToFile(
  content: string,
  format: OutputFileFormat,
  slug: string,
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  // ... switch(format) pour les formats Phase A
  // 'docx' | 'pdf' → throw new Error('Phase B — not yet implemented, use remark-docx task')
}
```

Formats Phase A à implémenter dans le switch :
| Format | Strip fences | Sanitize | MIME type |
|---|---|---|---|
| `txt` | oui | non | `text/plain` |
| `md` | non | non | `text/markdown` |
| `csv` | oui | `sanitizeCsvFormulas()` | `text/csv` |
| `json` | oui | `JSON.parse` + `JSON.stringify` (validation) | `application/json` |
| `yaml` | oui | non | `text/yaml` |
| `html` | non | non | `text/html` |
| `py`, `ts`, `js`, `sh` | oui | non | `text/plain` |

### 2. `lib/execution/converters/validate.ts` — NOUVEAU

```ts
// Valider le contenu après conversion, avant persistance
export function validateArtifact(bytes: Buffer, format: OutputFileFormat): void {
  if (bytes.byteLength > MAX_ARTIFACT_SIZE_BYTES) {
    throw new Error(`Artifact exceeds 10 MB limit (${bytes.byteLength} bytes)`)
  }
  if (format === 'json') {
    // Valider que le JSON est parsable
    JSON.parse(bytes.toString('utf-8'))
  }
  if (format === 'csv') {
    // Valider que toutes les lignes ont le même nombre de colonnes
    const lines = bytes.toString('utf-8').split('\n').filter(Boolean)
    if (lines.length > 1) {
      const colCount = lines[0].split(',').length
      const badLine = lines.findIndex(l => l.split(',').length !== colCount)
      if (badLine > 0) throw new Error(`CSV: inconsistent column count at line ${badLine + 1}`)
    }
  }
}
```

### 3. `lib/agents/writer.ts`

Ajouter `buildWriterSystemPrompt(format?: OutputFileFormat): string` :
```ts
// Quand format est présent, ajouter en fin de system prompt :
// "OUTPUT INSTRUCTIONS: Output ONLY raw [FORMAT] content.
//  No markdown code fences. No preamble. No prose.
//  Start your response with the first [character/line] of the [format description]."
```

### 4. `lib/agents/runner.ts`

Dans le `case 'WRITER'`, après l'exécution du writer :

```ts
// NEW: convertir si output_file_format est spécifié
if (node.config?.output_file_format) {
  const { bytes, filename, mimeType } = await convertToFile(
    writerOutput.content,
    node.config.output_file_format,
    slugify(node.config.description ?? 'output'),
  )
  validateArtifact(bytes, node.config.output_file_format)
  await db.runArtifact.create({
    data: {
      run_id:        runId,
      node_id:       node.node_id,
      filename,
      mime_type:     mimeType,
      artifact_role: 'pending_review',   // promu par Phase 5
      data:          bytes,
      size_bytes:    bytes.byteLength,
    },
  })
}
```

**Supprimer `detectArtifactFormat()`** de `runner.ts` — cette fonction n'existe plus, le format est toujours explicite via `output_file_format`.

Dans le `case 'PYTHON_EXECUTOR'` :
```ts
// Mettre à jour artifact_role de 'pending_review' (défaut schema) à 'supplementary'
// C3 edge case
data: { artifact_role: 'supplementary', /* ... */ }
```

**C4 — auto-promotion WRITER sans REVIEWER :** ajouter un hook en fin d'exécution du run (quand `run.status` passe à `COMPLETED`) :
```ts
// Si run termine COMPLETED et qu'il existe des artifacts pending_review
// → les promouvoir automatiquement à 'primary'
await db.runArtifact.updateMany({
  where:  { run_id: runId, artifact_role: 'pending_review' },
  data:   { artifact_role: 'primary' },
})
// Mettre à jour Run.primary_artifact_id avec le premier artifact primary
```

### 5. Tests — `tests/execution/converters/`

- `text-to-file.test.ts` : CSV colonnes uniformes, JSON validity, stripMarkdownFences, taille max
- `validate.test.ts` : colonnes CSV incohérentes → throw, JSON invalide → throw, taille > 10MB → throw

---

## Critères de validation

- [ ] `convertToFile('hello,=world', 'csv', 'test')` → la cellule `=world` est préfixée `'=world`
- [ ] `convertToFile('# Title\n\nParagraph', 'md', 'doc')` → bytes contient le markdown brut
- [ ] `validateArtifact` throw sur JSON malformé
- [ ] `detectArtifactFormat` n'existe plus dans `runner.ts`
- [ ] PYTHON_EXECUTOR crée artifacts avec `artifact_role: 'supplementary'`
- [ ] Run COMPLETED sans REVIEWER → artifacts `pending_review` promus à `primary`
- [ ] `npx tsc --noEmit` zéro erreur
- [ ] Tous les tests Jest existants passent

---

## Commit

```
feat(converters): Phase A text-to-file converters + structured WRITER mode

- lib/execution/converters/text-to-file.ts: convertToFile() Phase A (txt,csv,json,yaml,html,code)
- lib/execution/converters/validate.ts: validateArtifact() size + JSON + CSV column check
- lib/agents/writer.ts: buildWriterSystemPrompt() structured mode
- lib/agents/runner.ts: post-WRITER convertWriterOutput() + PYTHON_EXECUTOR supplementary role
  + C4 auto-promotion on COMPLETED + remove detectArtifactFormat()
- tests/execution/converters/text-to-file.test.ts
- tests/execution/converters/validate.test.ts
```
