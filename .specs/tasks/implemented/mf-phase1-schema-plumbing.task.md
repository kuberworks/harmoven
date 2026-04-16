---
title: "MF-Phase1 — Schema + type plumbing (no behaviour change)"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md
depends_on: []
created: 2026-04-08
status: todo
round: 1
branch: feat/mf-phase1-schema-plumbing
---

## Objectif

Ajouter les champs Prisma et les types TypeScript nécessaires aux phases suivantes.
**Aucun changement de comportement** — zéro risque de régression.

---

## Fichiers à modifier / créer

### 1. `prisma/schema.prisma`

Ajouter sur le modèle `RunArtifact` (après le champ `expires_at` existant) :
```prisma
artifact_role  String  @default("pending_review")
// Valeurs : "pending_review" | "primary" | "supplementary" | "discarded"
```

Ajouter sur le modèle `Run` (après `total_cost_usd`) :
```prisma
primary_artifact_id  String?
```

Après modification :
```bash
npx prisma migrate dev --name add_artifact_role_primary_artifact_id
npx prisma generate
```

### 2. `lib/agents/handoff.ts`

Ajouter le champ `output_file_format` (optionnel) sur `PlannerNodeSchema` (Zod) :
```ts
output_file_format: z.enum([
  'txt', 'csv', 'json', 'yaml', 'html', 'md',
  'py', 'ts', 'js', 'sh',
  'docx', 'pdf',
]).optional(),
```

Ajouter l'interface `DesiredOutput` et l'étendre dans `ClassifierResultSchema` :
```ts
export const DesiredOutputSchema = z.object({
  format:      z.enum(['txt','csv','json','yaml','html','md','py','ts','js','sh','docx','pdf']),
  description: z.string(),
  produced_by: z.enum(['writer','python']),
})
export type DesiredOutput = z.infer<typeof DesiredOutputSchema>

// Dans ClassifierResultSchema — ajouter :
desired_outputs: z.array(DesiredOutputSchema).optional(),
```

### 3. `lib/execution/run-config.ts` — NOUVEAU

```ts
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
```

### 4. `openapi/v1.yaml`

- `RunArtifactMeta` schema : ajouter `artifact_role: { type: string, enum: [primary, supplementary, pending_review, discarded] }`
- `Run` schema : ajouter `primary_artifact_id: { type: string, nullable: true }`
- `PlannerNode` schema (si existant) : ajouter `output_file_format: { type: string }`

---

## Critères de validation

- [ ] `npx prisma migrate dev` s'exécute sans erreur
- [ ] `npx prisma generate` s'exécute sans erreur
- [ ] `npx tsc --noEmit` passe avec zéro erreur
- [ ] `npx jest --passWithNoTests --no-coverage` — tous les tests existants passent
- [ ] Aucun comportement agent/exécuteur modifié (grep `artifact_role` dans `runner.ts` → 0 occurrences nouvelles)

---

## Commit

```
feat(schema): add artifact_role, primary_artifact_id, DesiredOutput, RunConfig

- prisma/schema.prisma: RunArtifact.artifact_role, Run.primary_artifact_id
- prisma/migrations/: migration add_artifact_role_primary_artifact_id
- lib/agents/handoff.ts: output_file_format on PlannerNodeSchema, DesiredOutput type
- lib/execution/run-config.ts: new RunConfig interface + parseRunConfig()
- openapi/v1.yaml: artifact_role, primary_artifact_id, output_file_format
```
