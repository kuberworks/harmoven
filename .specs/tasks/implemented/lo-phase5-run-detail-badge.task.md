---
title: "LO-Phase5 — Run detail: 'forced' badge on overridden nodes"
spec: .specs/tasks/todo/llm-overrides-per-agent.feature.md
depends_on: [lo-phase2-executor-injection]
created: 2026-04-09
status: todo
round: 3
branch: feat/llm-overrides-per-agent
---

## Objectif

Dans la page run detail, quand un node a un `preferred_llm` dans sa metadata,
afficher un badge discret à côté du modèle LLM pour signaler que c'est un override
explicite (pas une sélection automatique).

Task mineure — nice-to-have pour la transparence.

---

## Fichier à modifier

### `app/(app)/projects/[projectId]/runs/[runId]/run-detail-client.tsx`

Localiser l'affichage de `node.llm_profile_id` dans le NodeCard.
Ajouter un badge conditionnel :

```tsx
{node.llm_profile_id && (
  <span className="text-xs text-muted-foreground font-mono">
    {node.llm_profile_id}
    {meta?.preferred_llm && (
      <span className="ml-1 text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1 py-0.5 rounded">
        {t('run.llm.forced_badge')}
      </span>
    )}
  </span>
)}
```

Où `meta` est déjà parsé depuis `node.metadata` (la NodeCard a déjà
un pattern de lecture des metadata pour `description`, etc.).

---

## i18n

Clé déjà spécifiée dans Phase 4 :
- `run.llm.forced_badge`: "forced" / "forcé"

---

## Critère de complétion

- Badge visible quand le node a `preferred_llm` dans metadata
- Badge absent quand la sélection est automatique
- `npx tsc --noEmit` passe
