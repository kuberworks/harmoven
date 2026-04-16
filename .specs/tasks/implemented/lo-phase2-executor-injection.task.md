---
title: "LO-Phase2 — Executor: inject preferred_llm on DAG expansion"
spec: .specs/tasks/todo/llm-overrides-per-agent.feature.md
depends_on: [lo-phase1-backend-api]
created: 2026-04-09
status: todo
round: 2
branch: feat/llm-overrides-per-agent
---

## Objectif

Quand le PLANNER complète et que l'executor expande le DAG (création des nodes
WRITER / REVIEWER), injecter `preferred_llm` dans la metadata de chaque node
depuis `run_config.llm_overrides[agent_type]`.

C'est la seule task qui touche l'executor. Elle est petite mais critique —
sans elle, seul le PLANNER reçoit l'override.

---

## Fichier à modifier

### `lib/execution/custom/executor.ts` — bloc post-PLANNER (~ligne 1150-1240)

Localiser le bloc `if (node.agent_type === 'PLANNER' && output.handoffOut != null)`.
Juste avant la boucle `for (const pn of plan.dag.nodes)`, lire les overrides :

```ts
// Lire les overrides UNE fois avant la boucle
const llmOverrides = ((currentRun.run_config as Record<string, unknown> | null)?.['llm_overrides'] ?? {}) as Record<string, string | undefined>
```

Dans la boucle, modifier le `metadata` lors du `db.node.create()` :

```diff
  metadata: {
    description:          pn.description,
    complexity:           pn.complexity,
    expected_output_type: pn.expected_output_type,
    domain_profile:       plan.domain_profile,
    dependencies:         remappedDeps,
+   ...(llmOverrides[pn.agent] ? { preferred_llm: llmOverrides[pn.agent] } : {}),
  },
```

---

## Vérification du flux complet

1. `runner.ts` → `makeAgentRunner()` → lit `meta['preferred_llm']` → set dans `selectionContext.preferredLlmId`
2. `ContextualLLMClient` → injecte `selectionContext` dans `options`
3. `DirectLLMClient.resolveProfile()` → `selectLlm({ preferredLlmId })` → score +20 pour le profil préféré
4. Résultat : le profil override est sélectionné sauf si des contraintes dures (confidentialité, juridiction) l'excluent → fallback silencieux.

**Aucun changement** dans runner.ts, selector.ts, ou client.ts. Le plumbing est déjà là.

---

## Points de vigilance

- Les `plan.dag.nodes` produites par le PLANNER utilisent `pn.agent` = `'WRITER'` ou
  `'REVIEWER'` — correspondance exacte avec les clés de `llm_overrides`.
- Si un agent type dans le plan n'est pas dans l'override (ex: CRITICAL_REVIEW, PYTHON_EXECUTOR),
  le spread `...(llmOverrides[pn.agent] ? ...)` ne fait rien — correct.
- Pas besoin de valider les IDs ici — déjà validé dans `route.ts` à la création du run.
  Si le profil est désactivé entre-temps, `selectLlm()` le dépriorise et tombe en fallback.

---

## Deuxième chemin : spawn_followup_runs

Le spawn (executor `_spawnFollowUp()`, si implémenté) crée des sous-runs qui passent
par `POST /api/runs` — ils héritent naturellement de `llm_overrides` via `run_config`
si le code de spawn le copie. Vérifier que `run_config` est propagé — sinon, hors scope
de cette task (feature séparée).

---

## Tests

### Existing tests à vérifier

- `tests/execution/t3.2-user-control.test.ts` — vérifie restartNode / replayNode.
  Pas impacté directement mais s'assurer que le test passe toujours.

### Nouveau test (ou extension)

Ajouter un test dans `tests/execution/` qui vérifie :
- Créer un run avec `run_config: { llm_overrides: { WRITER: 'claude-opus-4-6' } }`
- Simuler un PLANNER qui retourne un DAG avec un WRITER
- Vérifier que le Node WRITER créé a `metadata.preferred_llm === 'claude-opus-4-6'`

---

## Critère de complétion

- `npx tsc --noEmit` passe
- Tests existants passent
- Dans un run réel avec override WRITER, le run detail affiche le modèle forcé
