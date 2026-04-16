---
title: "LLM per-agent selection when creating a run"
created: 2026-04-09
status: todo
branch: feat/llm-overrides-per-agent
tasks:
  - lo-phase1-backend-api       # run-config + API route + validation DB
  - lo-phase2-executor-injection # executor DAG expansion injecte preferred_llm
  - lo-phase3-models-endpoint    # GET /api/models/available (non-admin)
  - lo-phase4-ui-form            # formulaire New Run + presets + i18n
  - lo-phase5-run-detail-badge   # badge "forced" dans NodeCard
  - lo-phase6-openapi            # openapi/v1.yaml
---

# LLM selection per agent type — feature spec

## 1. Objectif

Permettre à un utilisateur de choisir, à la création d'un run, quel modèle LLM
est utilisé pour les agents PLANNER, WRITER et REVIEWER.

L'expérience cible :
- **Simple by default** : rien à faire pour 90 % des cas. Le système choisit.
- **Preset d'abord** : un sélecteur "Economy / Standard / Power" suffit pour
  la majorité des power-users.
- **Override avancé** : un panneau déplié "Choisir par agent" pour les cas rares
  nécessitant un contrôle fin.
- **Transparence des coûts** : indicateur d'impact budgétaire quand on s'écarte
  de l'Auto.

---

## 2. Analyse critique : ce qu'on ne fait PAS

| Décision | Raison |
|---|---|
| Ne pas exposer CLASSIFIER | Toujours `fast`. Configurable = aucun gain, confusion garantie. |
| Ne pas exposer PYTHON_EXECUTOR / SMOKE_TEST / REPAIR | Agents d'infrastructure. L'utilisateur n'a aucune raison de les toucher. |
| Ne pas autoriser des profile IDs arbitraires | Sécurité. L'API valide contre les profils activés en DB. |
| Ne pas forcer un choix | `null` = Auto. Le système garde la main sur la sélection multi-critères. |
| Ne pas bloquer si le modèle est désactivé entre création et exécution | L'executor tombe en fallback silencieux. |
| Ne pas ajouter de sélecteur dans TOUS les endroits qui créent des runs | API keys, triggers, chaining → run_config accepte le champ, mais aucune UI là. |

---

## 3. Modèle de données

### 3.1 Extension de `run_config` (colonne JSON existante sur `Run`)

```ts
// lib/execution/run-config.ts — étendre RunConfigSchema

llm_overrides: z.object({
  PLANNER:  z.string().optional(),   // profile ID ou null = Auto
  WRITER:   z.string().optional(),
  REVIEWER: z.string().optional(),
}).optional(),
```

Pas de migration Prisma — `run_config` est déjà un champ `Json`.

### 3.2 Pas de nouveau modèle Prisma

Aucun nouveau champ de schéma. `run_config` absorbe les overrides.

---

## 4. Architecture — flux de données

```
[New Run Form]
    ↓  llm_overrides: { PLANNER: 'claude-opus-4-6', WRITER: 'claude-sonnet-4-6' }
    
POST /api/runs
    ↓  Validation Zod + vérification DB (profils activés)
    ↓  Stocké dans run_config.llm_overrides
    
executor.startRun()
    ↓  Lit run_config.llm_overrides
    ↓  Injecte preferred_llm dans metadata du node PLANNER
         (créé dans route.ts → besoin de passer l'override via metadata au moment de la création)

executor (DAG expansion après PLANNER)
    ↓  Crée les nodes WRITER/REVIEWER
    ↓  Injecte run_config.llm_overrides[pn.agent] dans metadata.preferred_llm
    
runner.ts → ContextualLLMClient → selectionContext.preferredLlmId
    ↓  Déjà supporté ! selectLlm() sait gérer preferredLlmId.
```

Le PLANNER est créé dans `route.ts` au moment de la création du run.
Les WRITER/REVIEWER sont créés dans `executor.ts` après expansion du DAG.
Les deux chemins ont besoin d'injecter `preferred_llm`.

---

## 5. Implémentation — phases

### Phase 1 : Backend (API + run_config)

#### 5.1 `lib/execution/run-config.ts`

Étendre `RunConfigSchema` :
```ts
const LLM_OVERRIDABLE_AGENTS = ['PLANNER', 'WRITER', 'REVIEWER'] as const

export const RunConfigSchema = z.object({
  // ... champs existants inchangés ...
  llm_overrides: z.object({
    PLANNER:  z.string().max(128).optional(),
    WRITER:   z.string().max(128).optional(),
    REVIEWER: z.string().max(128).optional(),
  }).optional(),
})
```

#### 5.2 `app/api/runs/route.ts`

Étendre le body Zod :
```ts
const CreateRunBody = z.object({
  // ... champs existants ...
  llm_overrides: z.object({
    PLANNER:  z.string().max(128).optional(),
    WRITER:   z.string().max(128).optional(),
    REVIEWER: z.string().max(128).optional(),
  }).optional(),
}).strict()
```

Validation server-side AVANT de créer le run :
```ts
// Si des overrides sont fournis, vérifier que chaque profile ID est activé en DB.
// Cette vérification est faite en DB, pas sur BUILT_IN_PROFILES, pour respecter
// le fait que la DB est la source de vérité (admin peut désactiver un profil).
if (body.llm_overrides) {
  const requestedIds = Object.values(body.llm_overrides).filter(Boolean) as string[]
  if (requestedIds.length > 0) {
    const enabled = await db.llmProfile.findMany({
      where: { id: { in: requestedIds }, enabled: true },
      select: { id: true },
    })
    const enabledIds = new Set(enabled.map(p => p.id))
    const invalid = requestedIds.filter(id => !enabledIds.has(id))
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Unknown or disabled LLM profile(s): ${invalid.join(', ')}` },
        { status: 422 },
      )
    }
  }
}
```

Injection dans le metadata du node PLANNER lors de la création :
```ts
metadata: {
  task_input: taskInputStr,
  domain_profile: body.domain_profile,
  ...(body.llm_overrides?.PLANNER ? { preferred_llm: body.llm_overrides.PLANNER } : {}),
},
```

Stockage dans `run_config` :
```ts
run_config: {
  providers: [],
  ...(body.enable_web_search ? { enable_web_search: true } : {}),
  ...(body.llm_overrides     ? { llm_overrides: body.llm_overrides } : {}),
},
```

#### 5.3 `lib/execution/custom/executor.ts` — DAG expansion

Dans le bloc de création des Node records après PLANNER (ligne ~1210),
injecter `preferred_llm` depuis `run_config.llm_overrides` :

```ts
// Lire les overrides UNE fois avant la boucle
const runConfigRaw = currentRun.run_config as Record<string, unknown> | null
const llmOverrides = (runConfigRaw?.['llm_overrides'] ?? {}) as Record<string, string | undefined>

// Dans la boucle for (const pn of plan.dag.nodes)
metadata: {
  description:          pn.description,
  complexity:           pn.complexity,
  expected_output_type: pn.expected_output_type,
  domain_profile:       plan.domain_profile,
  dependencies:         remappedDeps,
  // Inject override if provided for this agent type
  ...(llmOverrides[pn.agent] ? { preferred_llm: llmOverrides[pn.agent] } : {}),
},
```

**Aucun changement** nécessaire dans `runner.ts` ou `ContextualLLMClient` :
`preferred_llm` dans node.metadata est déjà lu et routé vers `selectLlm()`.

#### 5.4 Nouveau endpoint public : `GET /api/models/available`

Endpoint accessible par tout utilisateur authentifié (pas admin-only).
Retourne les profils activés, avec les informations nécessaires à l'UI.

```
GET /api/models/available
Authorization: session (any authenticated user)
Response: {
  profiles: Array<{
    id: string
    model_string: string
    tier: 'fast' | 'balanced' | 'powerful'
    provider: string
    cost_per_1m_input_tokens: number
    cost_per_1m_output_tokens: number
    context_window: number
  }>
}
```

Ce endpoint lit `db.llmProfile.findMany({ where: { enabled: true } })`.
Il ne retourne pas `api_key_enc`, `api_key_env`, ni `config` (données admin).

Sécurité : pas de données sensibles — tier/cost/id uniquement.

---

### Phase 2 : UI — formulaire New Run

#### 5.5 `app/(app)/projects/[projectId]/runs/new/page.tsx`

**Structure UX :**

```
[Existing form fields: task, domain, output format, budget, web search]

── ▸ Model selection  [collapsed by default, toggled by click] ──────

  Quality preset:
  ○ Auto (recommended)   — System picks per task complexity
  ○ Economy              — Fast models for all agents (lowest cost)
  ○ Standard             — Balanced models (recommended for most tasks)
  ○ Power                — Most capable models (best quality, higher cost)
  ○ Custom               — Choose per agent ↓

  [visible only when Custom selected]
  Planning agent:   [Select: Auto | claude-haiku | claude-sonnet | claude-opus]
  Writing agent:    [Select: Auto | claude-haiku | claude-sonnet | claude-opus]
  Reviewing agent:  [Select: Auto | claude-haiku | claude-sonnet | claude-opus]

  [cost hint] ℹ Estimated cost impact: ~3× vs Auto

[Submit button]
```

**Mapping preset → overrides :**

| Preset | PLANNER | WRITER | REVIEWER |
|---|---|---|---|
| Auto | null | null | null |
| Economy | fast profile | fast profile | fast profile |
| Standard | balanced profile | balanced profile | balanced profile |
| Power | powerful profile | powerful profile | powerful profile |
| Custom | per-select | per-select | per-select |

Le mapping utilise le premier profil du tier en question dans la liste retournée
par `GET /api/models/available`. Si un tier n'a pas de profil activé, l'option
correspondante est désactivée.

**Affichage des modèles dans les selects :**

Groupés par tier, avec nom friendly :
```
Auto (recommended)
── Fast
   Claude Haiku  ·  $0.80 / M in
── Balanced
   Claude Sonnet  ·  $3.00 / M in
── Powerful
   Claude Opus  ·  $15.00 / M in
```

Ne jamais montrer le model_string brut (`claude-haiku-4-5-20251001`).
Utiliser `id` (e.g. `claude-haiku-4-5`) comme display name, épuré.

**État initial :** section fermée, preset = Auto.

**Chargement des profils :** `useEffect` → `fetch('/api/models/available')`.
Pendant le chargement, la section est désactivée avec un skeleton.
Si l'endpoint échoue, la section est masquée (non-bloquant).

**Données envoyées :**

```ts
// Seulement si preset !== 'auto' et que des overrides réels sont définis
if (llmOverrides.PLANNER || llmOverrides.WRITER || llmOverrides.REVIEWER) {
  body['llm_overrides'] = llmOverrides
}
```

---

### Phase 3 : Display dans le run detail

#### 5.6 `app/(app)/projects/[projectId]/runs/[runId]/run-detail-client.tsx`

Déjà affiché : le `llm_profile_id` est visible dans le `NodeCard` pendant l'exécution
(via `node_snapshot` SSE). Ajouter : si la node a un `preferred_llm` dans sa metadata,
afficher un badge "⚙ forced" à côté du modèle affiché pour différencier un override
explicite d'une sélection automatique.

---

## 6. OpenAPI — `openapi/v1.yaml`

Mettre à jour :

1. `POST /runs` body schema : ajouter `llm_overrides` avec description + exemple
2. Nouveau path `GET /models/available` avec son response schema
3. Schema `LlmOverrides` partagé

---

## 7. i18n

Nouvelles clés à ajouter dans `locales/en.json` et `locales/fr.json` :

```json
{
  "run.llm.section_label": "Model selection",
  "run.llm.preset.auto": "Auto (recommended)",
  "run.llm.preset.economy": "Economy",
  "run.llm.preset.standard": "Standard",
  "run.llm.preset.power": "Power",
  "run.llm.preset.custom": "Custom",
  "run.llm.preset.auto_hint": "The system picks the best model for each task",
  "run.llm.preset.economy_hint": "Fast models — lowest cost, suitable for simple tasks",
  "run.llm.preset.standard_hint": "Balanced models — recommended for most tasks",
  "run.llm.preset.power_hint": "Most capable models — best quality, higher cost",
  "run.llm.agent.planner": "Planning agent",
  "run.llm.agent.writer": "Writing agent",
  "run.llm.agent.reviewer": "Reviewing agent",
  "run.llm.model_auto": "Auto",
  "run.llm.cost_hint": "Estimated cost impact: ~{{multiplier}}× vs Auto",
  "run.llm.loading": "Loading available models…",
  "run.llm.forced_badge": "forced"
}
```

---

## 8. Sécurité — points de contrôle

| Point | Contrôle |
|---|---|
| Profile IDs inconnus | Rejetés en 422 par l'API (vérification DB) |
| Profil désactivé entre création et exécution | Executor log warning + fallback Auto silencieux |
| Exposition de données admin | `GET /api/models/available` ne retourne pas api_key_enc / config |
| Injection via llm_overrides | `.strict()` sur le schema Zod — aucun champ non déclaré accepté |
| Privilege escalation | Tout user avec `runs:create` peut sélectionner un modèle — correct (l'admin contrôle l'activation des profils) |
| Array injection / DoS | Zod limite à 3 clés connues, valeurs `string.max(128)` |

---

## 9. Tests

### Unit
- `lib/execution/run-config.ts` : `RunConfigSchema` accepte/rejette correctement `llm_overrides`
- `app/api/runs/route.ts` : POST avec override invalide retourne 422 ; override valide stocké dans run_config

### Integration (executor)
- PLANNER node crée avec metadata.preferred_llm si override PLANNER fourni
- Après expansion DAG, WRITER/REVIEWER nodes ont metadata.preferred_llm depuis run_config.llm_overrides

### E2E (Playwright — si suite disponible)
- Formulaire charge les modèles, sélection d'un preset "Power" envoie les bons overrides

---

## 10. Plan de déploiement

Pas de migration de schéma.
Pas de seed de données.
Déploiement direct : les runs existants ont `llm_overrides: undefined` → comportement inchangé.

---

## 11. Ce qui est hors scope (intentionnellement)

- Override au niveau projet (profil LLM par défaut par projet) → feature séparée
- Override au niveau trigger → future itération
- Override de CLASSIFIER → non justifié, hors scope
- UI sur les pages API keys / triggers → non justifié pour cette feature
- Comptabilité budgétaire prévisionnelle (estimation de coût précise avant run) → besoin d'un pricing calculator séparé
