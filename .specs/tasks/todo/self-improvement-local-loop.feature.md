---
title: "Self-Improvement Local Loop — Instance health analysis & suggestions (Docker-only)"
status: todo
created: 2026-04-14
depends_on: []
agents_completed: []
agents_pending: [code-explorer, implementer]
amendment: 92
---

## Overview

Harmoven analyse en continu ses propres runs passés (stockés en PostgreSQL locale)
pour détecter les patterns de dégradation et générer des **suggestions d'amélioration
actionnables** visibles dans le panneau admin.

**Scope strict :** déploiement Docker uniquement (`deployment_mode: docker` dans
`orchestrator.yaml`). Les données ne quittent jamais le conteneur — pas de télémetrie,
pas d'appel HTTP externe, pas de SaaS. Toute l'analyse est une requête Postgres locale.

**Non-scope :** envoi de données à Harmoven (délibérément exclu — aucune route externe
dans cette spec).

---

## Principe de fonctionnement

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                       Docker container (local Postgres)                       │
│                                                                               │
│  [Cron weekly]                                                                │
│      │                                                                        │
│      ▼                                                                        │
│  lib/self-improvement/analyzer.ts                                             │
│      │  SQL queries → Node, EvalResult, Run, HumanGate                       │
│      │  Returns: InstanceMetrics                                              │
│      ▼                                                                        │
│  lib/self-improvement/suggestions.ts                                         │
│      │  Rule engine → ImprovementSuggestion[]                                │
│      ▼                                                                        │
│  prisma: ImprovementSuggestion rows upserted                                 │
│      │                                                                        │
│  Admin UI: /admin/self-improvement                                            │
│      │  Cards per suggestion: severity | explain | evidence | apply/dismiss  │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Types de suggestions

| Type | Source de données | Condition de déclenchement |
|------|-------------------|---------------------------|
| `LLM_PROFILE_ERROR_RATE` | `Node` GROUP BY llm_profile_id, agent_type | error rate > 25 % sur 30 j ET ≥ 10 nœuds |
| `LLM_PROFILE_LOW_SCORE` | `EvalResult` JOIN `Node` | avg overall_score < 2.5/5 sur 30 j ET ≥ 5 evals |
| `RETRY_STORM` | `Node` WHERE retries > 0 | avg retries > 1.5 par nœud sur 7 j, par agent_type |
| `REVIEWER_REJECTION_RATE` | `EvalResult` WHERE overall_verdict = 'REQUEST_REVISION' | taux rejet > 40 % sur 30 j ET ≥ 10 evals |
| `BUDGET_OVERSHOOT` | `Run` WHERE budget_usd IS NOT NULL | > 50 % des runs d'un projet dépassent le budget |
| `GATE_FREQUENCY` | `HumanGate` GROUP BY reason | > 30 % des runs déclenchent une gate avec la même raison |
| `GATE_ABANDONMENT` | `HumanGate` WHERE status = 'OPEN' AND opened_at < now() - 48h | gates orphelines (config probablement cassée) |

### Sévérités

| Niveau | Couleur UI | Signification |
|--------|-----------|---------------|
| `critical` | rouge | Dégradation active, action recommandée maintenant |
| `warning` | ambre | Tendance détectée, surveiller |
| `info` | bleu | Observation, pas d'urgent |

### Action apply (uniquement pour les types à faible risque)

- `LLM_PROFILE_ERROR_RATE` (critical only) → `LlmProfile.enabled = false` + AuditLog entry
- Tous les autres → **dismiss uniquement** (les autres suggestions sont diagnotics, pas auto-applicables)

---

## Phases d'implémentation

### Phase 1 — Schéma Prisma + types + config

**Fichiers :**

#### `prisma/schema.prisma`

Ajouter le modèle `ImprovementSuggestion` :

```prisma
// ─── Self-Improvement Suggestions (Amendment 92) ──────────────────────────────
// Generated locally by lib/self-improvement/analyzer.ts on a weekly cron.
// NO data is ever sent externally. All analysis queries local Postgres only.
// Suggestions are instance_admin-only (admin:* permission required).

model ImprovementSuggestion {
  id           String   @id @default(uuid())
  type         String   // LLM_PROFILE_ERROR_RATE | LLM_PROFILE_LOW_SCORE | RETRY_STORM |
                        // REVIEWER_REJECTION_RATE | BUDGET_OVERSHOOT | GATE_FREQUENCY | GATE_ABANDONMENT
  severity     String   // critical | warning | info
  title        String   // short human label (i18n key value resolved at render-time)
  body         String   // markdown explanation (local, English)
  evidence     Json     // structured evidence payload — see types.ts SuggestionEvidence
  // For LLM_PROFILE_ERROR_RATE only: profile_id to disable
  target_id    String?  // LlmProfile.id | null
  target_type  String?  // 'llm_profile' | 'project' | 'gate_config' | null
  // Lifecycle
  status       String   @default("open")  // open | applied | dismissed | superseded
  applied_at   DateTime?
  applied_by   String?
  dismissed_at DateTime?
  dismissed_by String?
  // Cycle tracking — deduplicate on re-analysis
  cycle_key    String   @unique  // deterministic key: type + target_id + window, e.g. "LLM_PROFILE_ERROR_RATE:claude-haiku-4-5:30d"
  generated_at DateTime @default(now())
  expires_at   DateTime // = generated_at + 14d (removed from UI, kept for history)

  @@index([status])
  @@index([severity])
  @@index([generated_at])
}
```

#### `lib/self-improvement/types.ts`

```ts
// SuggestionType, SuggestionSeverity, SuggestionEvidence, SelfImprovementConfig
// (see implementation below)
```

Types à définir :

```ts
export type SuggestionType =
  | 'LLM_PROFILE_ERROR_RATE'
  | 'LLM_PROFILE_LOW_SCORE'
  | 'RETRY_STORM'
  | 'REVIEWER_REJECTION_RATE'
  | 'BUDGET_OVERSHOOT'
  | 'GATE_FREQUENCY'
  | 'GATE_ABANDONMENT'

export type SuggestionSeverity = 'critical' | 'warning' | 'info'

// Structured evidence shown in the UI card
export interface SuggestionEvidence {
  window_days:  number         // analysis window used
  sample_count: number         // number of nodes/runs/evals analysed
  metric_value: number         // the measured value (e.g. error rate 0.31)
  metric_label: string         // human label e.g. "31% error rate"
  threshold:    number         // threshold that triggered this suggestion
  extras?:      Record<string, unknown>  // type-specific details
}

// orchestrator.yaml → self_improvement section
export interface SelfImprovementConfig {
  enabled:                boolean   // default: true
  analysis_interval_days: number    // default: 7 (weekly)
  lookback_days:          number    // default: 30
  min_sample_size:        number    // default: 10 (don't alert on < N events)
  // Thresholds (admin can tune via orchestrator.yaml)
  threshold_error_rate:         number  // default: 0.25
  threshold_low_score:          number  // default: 2.5
  threshold_retry_avg:          number  // default: 1.5
  threshold_rejection_rate:     number  // default: 0.40
  threshold_budget_overshoot:   number  // default: 0.50
  threshold_gate_frequency:     number  // default: 0.30
  // telemetry is intentionally NOT present in this config
  // (no data is ever sent externally)
}

export const DEFAULT_SELF_IMPROVEMENT_CONFIG: SelfImprovementConfig = {
  enabled:                      true,
  analysis_interval_days:       7,
  lookback_days:                30,
  min_sample_size:              10,
  threshold_error_rate:         0.25,
  threshold_low_score:          2.5,
  threshold_retry_avg:          1.5,
  threshold_rejection_rate:     0.40,
  threshold_budget_overshoot:   0.50,
  threshold_gate_frequency:     0.30,
}
```

#### `orchestrator.yaml` (nouveau bloc)

```yaml
self_improvement:
  enabled: true
  analysis_interval_days: 7
  lookback_days: 30
  min_sample_size: 10
  # Thresholds for suggestion triggers (tune as needed)
  threshold_error_rate: 0.25
  threshold_low_score: 2.5
  threshold_retry_avg: 1.5
  threshold_rejection_rate: 0.40
  threshold_budget_overshoot: 0.50
  threshold_gate_frequency: 0.30
  # NOTE: telemetry is NOT supported. No data is ever sent externally.
```

**Migration Prisma requise :**

```bash
npx prisma migrate dev --name add_improvement_suggestion
npx prisma generate
```

---

### Phase 2 — Analyzer + suggestion engine

#### `lib/self-improvement/config.ts`

Lit le bloc `self_improvement` depuis `orchestrator.yaml` (pattern identique à
`lib/updates/version-check.ts:readUpdatesConfig`). Merge avec `DEFAULT_SELF_IMPROVEMENT_CONFIG`.

#### `lib/self-improvement/analyzer.ts`

Exports : `computeInstanceMetrics(cfg: SelfImprovementConfig): Promise<InstanceMetrics>`

Queries Prisma (toutes locales, paramétrées — pas d'injection SQL) :

```ts
interface InstanceMetrics {
  // Per-profile per-agent-type stats
  profileNodeStats: Array<{
    llm_profile_id: string
    agent_type:     string
    total:          number
    errors:         number
    retries_sum:    number
    avg_retries:    number
    error_rate:     number
  }>
  // Per-profile eval scores
  profileEvalStats: Array<{
    llm_used:    string
    total_evals: number
    avg_score:   number
    rejection_rate: number
  }>
  // Per-project budget stats
  projectBudgetStats: Array<{
    project_id:    string
    runs_with_budget: number
    runs_overshoot: number
    overshoot_rate: number
  }>
  // Gate stats
  gateFrequencyStats: Array<{
    reason: string
    count:  number
    rate:   number  // gates_with_reason / total_completed_runs
  }>
  gateAbandonedCount: number
  // Window info
  from: Date
  to:   Date
}
```

Implémentation : requêtes `db.node.groupBy`, `db.evalResult.groupBy`, `db.run.findMany`,
`db.humanGate.groupBy`. Pas d'utilisation de `$queryRaw` (SQL brut interdit —
surface d'injection nulle).

#### `lib/self-improvement/suggestions.ts`

Exports : `generateSuggestions(metrics: InstanceMetrics, cfg: SelfImprovementConfig): ImprovementSuggestionInput[]`

Pur algorithme (pas d'accès DB). Applique les règles définies dans le tableau "Types de
suggestions" ci-dessus. Génère le `cycle_key` déterministe par suggestion pour permettre
l'upsert sans doublon.

Format `cycle_key` :
- `LLM_PROFILE_ERROR_RATE:{profile_id}:{window_days}d`
- `LLM_PROFILE_LOW_SCORE:{profile_id}:{window_days}d`
- `RETRY_STORM:{agent_type}:{window_days}d`
- `REVIEWER_REJECTION_RATE:global:{window_days}d`
- `BUDGET_OVERSHOOT:{project_id}:{window_days}d`
- `GATE_FREQUENCY:{reason}:{window_days}d`
- `GATE_ABANDONMENT:global:{window_days}d`

#### `lib/self-improvement/runner.ts`

Exports : `runSelfImprovementCycle(): Promise<void>`

Orchestration complète :
1. Lire config depuis `orchestrator.yaml`
2. Si `!cfg.enabled` → return
3. `computeInstanceMetrics(cfg)`
4. `generateSuggestions(metrics, cfg)`
5. Pour chaque suggestion : `db.improvementSuggestion.upsert` sur `cycle_key`
   - Si suggestion existante avec `status = 'dismissed'` → ne pas ré-ouvrir
   - Si suggestion existante avec `status = 'applied'` → ne pas ré-ouvrir
   - Si suggestion existante avec `status = 'open'` → mettre à jour `generated_at` et `evidence`
   - Nouvelle suggestion → créer avec `status = 'open'`
6. Purger les lignes avec `expires_at < now()` ET `status != 'open'`
7. Logger `[self-improvement] cycle complete: N suggestions upserted` (pas de données sensibles)

---

### Phase 3 — Intégration cron

#### `instrumentation.ts` (ou nouveau fichier dédié `lib/self-improvement/cron.ts`)

Intégrer dans le scheduler d'instance (même pattern que la vérification des mises à jour).
Le cron ne se déclenche que si `deployment_mode === 'docker'` dans `orchestrator.yaml`.

Intervalle configurable via `analysis_interval_days` → convertir en ms pour `setInterval`.
Déclencher aussi au démarrage (une fois, après 60s de délai).

#### Routes API

**`app/api/admin/self-improvement/suggestions/route.ts`**

```
GET /api/admin/self-improvement/suggestions
```

- Auth : `instance_admin` uniquement (`admin:*` permission)
- Query params : `?status=open|applied|dismissed|all` (défaut : `open`)
- Retourne : `ImprovementSuggestion[]` avec `evidence` JSON parsé
- Décimalises/Dates sérialisées en primitifs

**`app/api/admin/self-improvement/suggestions/[id]/apply/route.ts`**

```
POST /api/admin/self-improvement/suggestions/:id/apply
```

- Auth : `instance_admin`
- Accepté uniquement si `type === 'LLM_PROFILE_ERROR_RATE'` ET `severity === 'critical'`
  ET `status === 'open'` ET `target_id` est un `LlmProfile.id` valide
- Action : `db.llmProfile.update({ where: { id }, data: { enabled: false } })`
- Puis : `db.improvementSuggestion.update({ status: 'applied', applied_at, applied_by })`
- Puis : écrire une ligne `AuditLog` (`action_type: 'self_improvement.apply'`, `actor: session.user.id`)
- Retourne : `{ ok: true }`

**`app/api/admin/self-improvement/suggestions/[id]/dismiss/route.ts`**

```
POST /api/admin/self-improvement/suggestions/:id/dismiss
```

- Auth : `instance_admin`
- Action : `db.improvementSuggestion.update({ status: 'dismissed', dismissed_at, dismissed_by })`
- Retourne : `{ ok: true }`

**`app/api/admin/self-improvement/trigger/route.ts`**

```
POST /api/admin/self-improvement/trigger
```

- Auth : `instance_admin`
- Lance `runSelfImprovementCycle()` en arrière-plan (fire-and-forget)
- Retourne immédiatement `{ ok: true, message: 'Analysis cycle started' }`
- Rate-limit : 1 déclenchement manuel par heure (vérifier `ImprovementSuggestion.generated_at`)

---

### Phase 4 — UI Admin

#### `app/(app)/admin/self-improvement/page.tsx` (Server Component)

- Auth : `instance_admin` guard (redirect si non-admin)
- Fetch suggestions `status=open` depuis `/api/admin/self-improvement/suggestions`
- Passer les données sérialisées au Client Component
- Afficher le titre "Instance Health" + date de la dernière analyse

#### `app/(app)/admin/self-improvement/self-improvement-client.tsx` (Client Component)

Interface :

```
┌─────────────────────────────────────────────────────────────────────┐
│ Instance Health                   [Analyser maintenant]             │
│ Dernière analyse : il y a 2 jours                                   │
├─────────────────────────────────────────────────────────────────────┤
│ ⛔ CRITIQUE   LLM Profile claude-haiku-4-5 — 31 % d'erreurs (WRITER)│
│ 10j window · 47 nœuds analysés                                      │
│ Ce profil a un taux d'erreur élevé sur les nœuds WRITER.            │
│ Recommandation : désactiver ce profil et utiliser une alternative.  │
│                                          [Désactiver] [Ignorer]      │
├─────────────────────────────────────────────────────────────────────┤
│ ⚠ AVERTISSEMENT  Taux de rejet REVIEWER — 43 % sur 30 j            │
│ 12 évaluations · avg score 2.1/5                                    │
│ Plus de 40 % des contenus générés demandent une révision.           │
│ Vérifiez la config du profil de domaine ou les prompts.             │
│                                                       [Ignorer]      │
│ ...                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

Comportements :
- Toast succès/erreur après apply ou dismiss
- Après apply : la card passe en état "appliqué" (badge vert) puis disparaît après 3s
- Après dismiss : idem avec badge "ignoré"
- Bouton "Analyser maintenant" : POST `/api/admin/self-improvement/trigger` + toast

#### Entrée dans le menu admin

Ajouter un lien "Instance Health" dans la sidebar admin (`components/admin/` ou
`app/(app)/admin/layout.tsx`). Badge numérique rouge si suggestions `critical` > 0.

---

### Phase 5 — i18n et OpenAPI

#### `locales/en.json` et `locales/fr.json`

Clés à ajouter :

```json
{
  "admin.self_improvement.title": "Instance Health",
  "admin.self_improvement.last_analysis": "Last analysis",
  "admin.self_improvement.trigger_now": "Analyse now",
  "admin.self_improvement.triggered": "Analysis started",
  "admin.self_improvement.no_suggestions": "No active suggestions — instance looks healthy",
  "admin.self_improvement.severity.critical": "Critical",
  "admin.self_improvement.severity.warning": "Warning",
  "admin.self_improvement.severity.info": "Info",
  "admin.self_improvement.apply": "Apply fix",
  "admin.self_improvement.dismiss": "Dismiss",
  "admin.self_improvement.applied": "Applied",
  "admin.self_improvement.dismissed": "Dismissed",
  "admin.self_improvement.type.LLM_PROFILE_ERROR_RATE": "High error rate on LLM profile",
  "admin.self_improvement.type.LLM_PROFILE_LOW_SCORE": "Low quality score on LLM profile",
  "admin.self_improvement.type.RETRY_STORM": "Excessive retries detected",
  "admin.self_improvement.type.REVIEWER_REJECTION_RATE": "High reviewer rejection rate",
  "admin.self_improvement.type.BUDGET_OVERSHOOT": "Runs consistently exceed budget",
  "admin.self_improvement.type.GATE_FREQUENCY": "Human gates triggered too often",
  "admin.self_improvement.type.GATE_ABANDONMENT": "Abandoned human gates detected"
}
```

#### `openapi/v1.yaml`

Documenter :
- `GET /admin/self-improvement/suggestions` → `ImprovementSuggestion[]`
- `POST /admin/self-improvement/suggestions/{id}/apply`
- `POST /admin/self-improvement/suggestions/{id}/dismiss`
- `POST /admin/self-improvement/trigger`
- Schéma `ImprovementSuggestion` (sans champs `applied_by`/`dismissed_by` dans la réponse)
- Note de sécurité : toutes ces routes requièrent `instance_admin`

---

## Structure des fichiers

```
lib/
  self-improvement/
    types.ts          ← SuggestionType, SuggestionEvidence, SelfImprovementConfig
    config.ts         ← readSelfImprovementConfig() depuis orchestrator.yaml
    analyzer.ts       ← computeInstanceMetrics() — requêtes Postgres locales uniquement
    suggestions.ts    ← generateSuggestions() — algorithme pur, pas d'accès DB
    runner.ts         ← runSelfImprovementCycle() — orchestration + upsert DB

app/
  (app)/admin/self-improvement/
    page.tsx                       ← Server Component, auth guard
    self-improvement-client.tsx    ← Client Component, cards + actions

  api/admin/self-improvement/
    suggestions/
      route.ts                     ← GET (list)
      [id]/
        apply/route.ts             ← POST
        dismiss/route.ts           ← POST
    trigger/
      route.ts                     ← POST (manual trigger)

prisma/
  schema.prisma                    ← nouveau model ImprovementSuggestion
  migrations/
    YYYYMMDDHHMMSS_add_improvement_suggestion/
```

---

## Note RGPD

Le RGPD (Art. 2 §1) ne s'applique qu'au traitement de **données à caractère
personnel** (DCP) — toute information se rapportant à une personne physique
identifiée ou identifiable.

**L'analyzer lui-même ne traite pas de DCP.** Il lit uniquement des métriques
techniques d'un système : `Node.status`, `cost_usd`, `retries`, `agent_type`,
`llm_profile_id`, `EvalResult.overall_score`, `HumanGate.reason` (codes machine
comme `low_confidence`). Aucune personne physique n'est identifiable depuis ces
champs. Le RGPD ne s'applique pas à cette couche d'analyse.

**Les deux seuls champs DCP dans cette feature :**

| Champ | Table | Pourquoi c'est une DCP |
|-------|-------|------------------------|
| `applied_by` | `ImprovementSuggestion` | user ID d'un admin → personne physique identifiée |
| `dismissed_by` | `ImprovementSuggestion` | idem |

**Contraintes sur ces deux champs (Art. 5 §1 c) minimisation) :**
- Ne jamais les retourner dans les réponses API — utiliser un `select` Prisma
  explicite qui les exclut
- Pas de FK vers `User` (intentionnel — cohérent avec `AuditLog.actor`) : la
  suppression d'un utilisateur (droit à l'effacement) n'est pas bloquée
- Purgés automatiquement avec la ligne `ImprovementSuggestion` à `expires_at`

**Durée de conservation des lignes `ImprovementSuggestion` :**
14 jours après génération (`expires_at = generated_at + 14d`), purge dans `runner.ts`.

---

## Contraintes de sécurité

| Contrainte | Mise en œuvre |
|-----------|---------------|
| Aucune donnée externe | Analyzer ne fait aucun `fetch()`. Vérifier avec `grep -r 'fetch\|axios\|http' lib/self-improvement/` en CI. |
| Pas d'injection SQL | Utiliser exclusivement l'API Prisma type-safe (groupBy, findMany, aggregate). Aucun `$queryRaw`. |
| Route admin uniquement | Chaque route vérifie `perms.has('admin:*')` avant traitement. |
| Apply limité | Seul `LLM_PROFILE_ERROR_RATE` + `critical` a un apply. L'action désactive un profil (réversible par admin). |
| AuditLog | Chaque apply écrit une entrée AuditLog avec actor = userId. |
| TTL suggestions | `expires_at = generated_at + 14d` — purge automatique des suggestions stales. |
| Rate-limit trigger manuel | 1 déclenchement manuel/heure via vérification de `generated_at` en DB. |

---

## Invariants de déploiement

- Le bloc `self_improvement` dans `orchestrator.yaml` est **opt-out** (activé par défaut).
  Un admin peut couper la feature avec `enabled: false`.
- La feature est conditionnée à `deployment_mode: docker` dans `orchestrator.yaml`.
  Elle est silencieusement no-op pour les autres modes.
- La feature tourne en arrière-plan — elle ne bloque jamais le démarrage de l'instance.
- En l'absence de `ImprovementSuggestion` en DB (première semaine), l'UI affiche
  "Aucune suggestion active" sans erreur.

---

## Exemples de `evidence` par type

### `LLM_PROFILE_ERROR_RATE`

```json
{
  "window_days": 30,
  "sample_count": 47,
  "metric_value": 0.31,
  "metric_label": "31% error rate",
  "threshold": 0.25,
  "extras": {
    "profile_id": "claude-haiku-4-5",
    "agent_type": "WRITER",
    "errors": 15,
    "total": 47,
    "recent_errors": ["LLM timeout after 30s", "Empty response from model", "JSON parse error at token 0"]
    // NOTE RGPD: alimenté depuis Node.error (message TS tronqué à 100 chars) — jamais depuis handoff_out
  }
}
```

### `REVIEWER_REJECTION_RATE`

```json
{
  "window_days": 30,
  "sample_count": 12,
  "metric_value": 0.43,
  "metric_label": "43% rejection rate",
  "threshold": 0.40,
  "extras": {
    "avg_score": 2.1,
    "top_rejection_reasons": ["placeholder content", "incomplete sections"],
    "affected_domain_profiles": ["data_reporting", "generic"]
  }
}
```

### `BUDGET_OVERSHOOT`

```json
{
  "window_days": 30,
  "sample_count": 20,
  "metric_value": 0.60,
  "metric_label": "60% runs over budget",
  "threshold": 0.50,
  "extras": {
    "project_id": "550e8400-...",
    "runs_with_budget": 20,
    "runs_overshoot": 12,
    "avg_overshoot_factor": 1.4
  }
}
```

---

## Checklist pré-merge

**Code & types**
- [ ] `npx tsc --noEmit` — 0 erreurs TypeScript
- [ ] `npx prisma migrate dev --name add_improvement_suggestion` appliqué
- [ ] `npx prisma generate` OK
- [ ] Tests unitaires pour `analyzer.ts` et `suggestions.ts` dans `tests/self-improvement/`
- [ ] `openapi/v1.yaml` mis à jour
- [ ] `locales/en.json` et `locales/fr.json` mis à jour
- [ ] Routes admin vérifiées : 401 si non connecté, 403 si non instance_admin

**Sécurité**
- [ ] `grep -rn 'fetch\|axios\|https://' lib/self-improvement/` → 0 résultats (garantie no-telemetrie)

**DCP (les deux seuls champs concernés)**
- [ ] Réponse API `GET /suggestions` : select Prisma explicite, `applied_by`/`dismissed_by` exclus
- [ ] Supprimer un `User` ne bloque pas sur FK `ImprovementSuggestion` (champs `String?` sans FK — intentionnel)
