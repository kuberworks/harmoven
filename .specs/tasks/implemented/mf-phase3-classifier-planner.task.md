---
title: "MF-Phase3 — CLASSIFIER desired_outputs + PLANNER format routing"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md#part-1
depends_on: [mf-phase1-schema-plumbing]
created: 2026-04-08
status: todo
round: 2
branch: feat/mf-phase3-classifier-planner
---

## Objectif

Permettre au CLASSIFIER de détecter l'intention de format de l'utilisateur (`desired_outputs`)
et au PLANNER de propager cette information en définissant `output_file_format` sur les nodes WRITER du DAG.

---

## Prérequis

Branche `feat/mf-phase1-schema-plumbing` mergée dans `develop`.
(Fournit `DesiredOutput` type et `output_file_format` sur `PlannerNodeSchema`)

---

## Spec de référence

- **Part 1 §1.1** — `ClassifierResult.desired_outputs`, type `DesiredOutput`
- **Part 1 §1.2** — règles de routing PLANNER
- **Part 3 §3.1** — priorité : form selector > CLASSIFIER detection (C2 rule)

---

## Fichiers à modifier

### 1. `lib/agents/classifier.ts`

Ajouter à la fin du **system prompt** du CLASSIFIER (ou dans la section json schema attendu) :

```
OPTIONAL OUTPUT FORMAT DETECTION:
If the user explicitly requests a specific file format or document type, add a
"desired_outputs" array. Only set this if the intent is unambiguous.
Examples that SHOULD set desired_outputs:
- "génère un rapport Word" → [{ format: "docx", description: "rapport final", produced_by: "writer" }]
- "exporte en CSV" → [{ format: "csv", description: "données exportées", produced_by: "writer" }]
- "écris un script Python" → [{ format: "py", description: "script Python", produced_by: "python" }]

Examples that should NOT set desired_outputs (ambiguous):
- "génère un rapport" (no format specified)
- "crée un document" (no format specified)

Do NOT set desired_outputs if the run config already has output_file_format set
(the form selector takes priority — C2 rule).
```

Ajouter `desired_outputs` dans le parse Zod de la réponse CLASSIFIER (champ optionnel, déjà défini dans `handoff.ts` via Phase 1).

### 2. `lib/agents/planner.ts`

Dans le system prompt du PLANNER, ajouter la règle de propagation :

```
FORMAT ROUTING:
If handoffIn contains desired_outputs:
- For each DesiredOutput with produced_by = "writer": set output_file_format on the
  corresponding WRITER node config (use the format value exactly as-is)
- For each DesiredOutput with produced_by = "python": add a PYTHON_EXECUTOR node after WRITER

OUTPUT FILE FORMAT PRIORITY (C2 rule):
If run_config.output_file_format is set (user selected format in the UI form),
it takes priority over desired_outputs from CLASSIFIER.
Always use run_config.output_file_format if present.
```

Côté TypeScript, dans le handler PLANNER de `runner.ts`, après avoir généré le DAG :
- Si `run_config.output_file_format` est défini : écraser `output_file_format` sur **tous** les nodes WRITER du DAG généré
- Si `desired_outputs` est défini dans le handoff CLASSIFIER : propager `output_file_format` aux WRITER nodes correspondants (seulement si `run_config.output_file_format` absent)

### 3. Tests — `tests/agents/classifier-desired-outputs.test.ts` — NOUVEAU

```ts
// Mocker le LLM pour retourner une réponse avec desired_outputs
// Vérifier que ClassifierResult.desired_outputs est correctement parsé
// Cas : "génère un CSV" → desired_outputs: [{ format: 'csv', ... }]
// Cas : "génère un rapport" → desired_outputs: undefined
```

### 4. Tests — `tests/agents/planner-format-routing.test.ts` — NOUVEAU

```ts
// Vérifier que si desired_outputs: [{ format: 'docx', produced_by: 'writer' }]
// → le DAG généré a un WRITER node avec output_file_format: 'docx'
// C2: si run_config.output_file_format = 'csv' → WRITER node a output_file_format: 'csv' (override)
```

---

## Règles importantes

- **C2 — Form selector prioritaire :** `run_config.output_file_format` écrase toujours `desired_outputs`. Ne jamais inverser cette priorité.
- Ne jamais crafter de `desired_outputs` si l'intention est ambiguë — mieux vaut ne pas le définir que de se tromper.
- Les formats `docx` et `pdf` peuvent être dans `desired_outputs` même si Phase B n'est pas encore livrée — le runner fera échouer la conversion avec un message clair.

---

## Critères de validation

- [ ] CLASSIFIER avec input "exporte en CSV" → `desired_outputs[0].format === 'csv'`
- [ ] CLASSIFIER avec input "génère un rapport" (ambigu) → `desired_outputs === undefined`
- [ ] PLANNER avec `desired_outputs: [{ format: 'py', produced_by: 'python' }]` → DAG contient un PYTHON_EXECUTOR
- [ ] `run_config.output_file_format = 'csv'` + `desired_outputs: [{ format: 'docx' }]` → WRITER node a `output_file_format: 'csv'`
- [ ] `npx tsc --noEmit` zéro erreur
- [ ] Tests Jest verts

---

## Commit

```
feat(agents): CLASSIFIER desired_outputs detection + PLANNER format routing (C2 rule)

- lib/agents/classifier.ts: desired_outputs in system prompt + Zod parse
- lib/agents/planner.ts: output_file_format propagation from desired_outputs
- lib/agents/runner.ts: C2 rule — run_config.output_file_format overrides desired_outputs
- tests/agents/classifier-desired-outputs.test.ts
- tests/agents/planner-format-routing.test.ts
```
