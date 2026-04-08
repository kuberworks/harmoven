---
title: "MF-Phase5 — REVIEWER artifact role promotion + SSE artifact_ready"
spec: .specs/tasks/draft/multi-format-artifact-output.feature.md#part-2
depends_on: [mf-phase1-schema-plumbing, mf-phase2-converters-writer]
created: 2026-04-08
status: todo
round: 3
branch: feat/mf-phase5-reviewer-artifact-role
---

## Objectif

- Faire promouvoir les artifacts de `pending_review` → `primary` ou `discarded` par le REVIEWER
- Émettre un event SSE `artifact_ready` après chaque création d'artifact (push ciblé vs polling)
- Exposer `artifact_role` et `primary_artifact_id` dans les endpoints API

---

## Prérequis

- `feat/mf-phase1-schema-plumbing` mergé : champs `artifact_role` + `primary_artifact_id` en DB
- `feat/mf-phase2-converters-writer` mergé : artifacts créés avec `artifact_role: 'pending_review'`

---

## Spec de référence

- **Part 2 §2.2** — event SSE `artifact_ready` (singulier, per-artifact)
- **Part 1 §1.8a** — C3 (PYTHON_EXECUTOR → `supplementary`) + C4 (WRITER sans REVIEWER → auto-`primary`)
- **Phase 5** dans le spec

---

## Fichiers à modifier

### 1. `types/events.ts`

Ajouter au discriminated union `RunSSEEvent` :

```ts
export type RunSSEEventArtifactReady = {
  type:          'artifact_ready'   // singulier — différent de 'artifacts_ready' (pluriel, batch)
  artifact_id:   string
  filename:      string
  mime_type:     string
  node_id:       string
  artifact_role: 'pending_review' | 'primary' | 'supplementary'
}
```

Ajouter `RunSSEEventArtifactReady` au `export type RunSSEEvent = ...`.

### 2. `lib/events/project-event-bus.interface.ts`

Ajouter au `RunSSEEvent` interne :
```ts
| { type: 'artifact_ready'; artifact_id: string; filename: string; mime_type: string; node_id: string; artifact_role: string }
```

### 3. `lib/execution/custom/executor.ts`

#### 3a — Émission `artifact_ready` après chaque `db.runArtifact.create()`

Partout où `db.runArtifact.create()` est appelé (WRITER converter + PYTHON_EXECUTOR), émettre :

```ts
await eventBus.emit({
  project_id,
  run_id: runId,
  event: {
    type:          'artifact_ready',
    artifact_id:   artifact.id,
    filename:      artifact.filename,
    mime_type:     artifact.mime_type,
    node_id,
    artifact_role: artifact.artifact_role,
  },
  emitted_at: new Date(),
})
```

#### 3b — Après REVIEWER APPROVE

```ts
// Si REVIEWER verdict === 'APPROVE'
// Promouvoir tous les artifacts pending_review du run
await db.runArtifact.updateMany({
  where:  { run_id: runId, artifact_role: 'pending_review' },
  data:   { artifact_role: 'primary' },
})

// Récupérer le premier artifact primary et mettre à jour Run.primary_artifact_id
const primaryArtifact = await db.runArtifact.findFirst({
  where:   { run_id: runId, artifact_role: 'primary' },
  orderBy: { created_at: 'asc' },
})
if (primaryArtifact) {
  await db.run.update({
    where: { id: runId },
    data:  { primary_artifact_id: primaryArtifact.id },
  })
}
```

#### 3c — Après REVIEWER REJECT / REQUEST_REVISION

```ts
await db.runArtifact.updateMany({
  where: { run_id: runId, artifact_role: 'pending_review' },
  data:  { artifact_role: 'discarded' },
})
```

#### 3d — Hook run COMPLETED sans REVIEWER (C4)

Dans le code qui fait passer le run à `COMPLETED` :

```ts
// C4: si aucun REVIEWER dans le DAG, les artifacts pending_review n'ont jamais été promus
// → auto-promotion à 'primary' pour que l'UI les affiche
const pendingCount = await db.runArtifact.count({
  where: { run_id: runId, artifact_role: 'pending_review' },
})
if (pendingCount > 0) {
  await db.runArtifact.updateMany({
    where: { run_id: runId, artifact_role: 'pending_review' },
    data:  { artifact_role: 'primary' },
  })
  const firstPrimary = await db.runArtifact.findFirst({
    where: { run_id: runId, artifact_role: 'primary' },
    orderBy: { created_at: 'asc' },
  })
  if (firstPrimary) {
    await db.run.update({
      where: { id: runId },
      data:  { primary_artifact_id: firstPrimary.id },
    })
  }
}
```

### 4. `app/api/runs/[runId]/artifacts/route.ts`

```ts
// SELECT : ajouter artifact_role
const artifacts = await db.runArtifact.findMany({
  where: {
    run_id: runId,
    // S3: filtrer discarded par défaut
    artifact_role: { not: 'discarded' },
    // ?include_discarded=true pour admin
    ...(includeDiscarded ? {} : undefined),
  },
  select: {
    id:            true,
    filename:      true,
    mime_type:     true,
    size_bytes:    true,
    created_at:    true,
    expires_at:    true,
    artifact_role: true,   // NEW
    node_id:       true,
  },
})
```

Lire `?include_discarded=true` via `searchParams` — retourner tous les artifacts si présent + vérification admin RBAC (`perms.has('admin:*')`).

### 5. `app/api/runs/[runId]/route.ts`

Inclure `primary_artifact_id` dans la réponse GET :
```ts
select: {
  // ... champs existants ...
  primary_artifact_id: true,  // NEW
}
```

---

## Critères de validation

- [ ] REVIEWER APPROVE → `artifact_role` passe à `'primary'` dans la DB
- [ ] REVIEWER REQUEST_REVISION → `artifact_role` passe à `'discarded'`
- [ ] Run COMPLETED sans REVIEWER → artifacts `pending_review` promus à `primary`
- [ ] `Run.primary_artifact_id` set correctement après promotion
- [ ] SSE event `artifact_ready` émis après chaque `db.runArtifact.create()`
- [ ] `GET /api/runs/:id/artifacts` ne retourne pas d'artifacts `discarded` par défaut
- [ ] `GET /api/runs/:id/artifacts?include_discarded=true` (admin only) retourne tous
- [ ] `GET /api/runs/:id` inclut `primary_artifact_id`
- [ ] `npx tsc --noEmit` zéro erreur
- [ ] Tests Jest existants passent

---

## Commit

```
feat(artifacts): REVIEWER promotion to primary/discarded + SSE artifact_ready

- types/events.ts: RunSSEEventArtifactReady (singulier, per-artifact)
- lib/events/project-event-bus.interface.ts: artifact_ready event
- lib/execution/custom/executor.ts: emit artifact_ready on create, REVIEWER APPROVE/REJECT
  promotion, C4 auto-promotion on COMPLETED
- app/api/runs/[runId]/artifacts/route.ts: artifact_role in select, filter discarded
- app/api/runs/[runId]/route.ts: primary_artifact_id in GET response
```
