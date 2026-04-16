---
title: "Prompt Store + PII Auto-Detection + Anonymisation (Amendment 93)"
status: todo
created: 2026-04-14
depends_on: [self-improvement-local-loop]
agents_completed: []
agents_pending: [code-explorer, implementer]
amendment: 93
---

## Problème

`PromptSummary` (Am.86) capture uniquement les métadonnées d'exécution — pas le
contenu des prompts. Le self-improvement analyzer (Am.92) ne peut donc pas détecter
les patterns de dégradation liés au **contenu** (ex : prompt trop long, ambiguïtés
récurrentes, erreurs de structure LLM).

Pour aller plus loin, il faut stocker les prompts complets.

**Tension :** certains déploiements envoient des données sensibles (noms, emails,
données médicales). D'autres sont 100 % techniques (code, logs). L'instance ne
sait pas a priori dans quelle catégorie elle est.

**Solution :** stocker optionnellement les prompts, détecter automatiquement la
présence de DCP, et appliquer la stratégie configurée (anonymiser, refuser de
stocker, ou stocker brut si aucune DCP n'est détectée).

---

## Architecture

```
Node exécuté
    │
    ▼
lib/privacy/detector.ts
    │  detectPii(text) → { hasPii, entities[], score }
    │  Stratégie : regex d'abord (rapide) → Presidio si activé (précis)
    │
    ▼
lib/privacy/anonymizer.ts
    │  anonymize(text, entities) → text avec [EMAIL_1], [PERSON_1], etc.
    │
    ▼
lib/prompt-store/recorder.ts
    │  Décide selon config :
    │    store_mode: 'off'            → rien
    │    store_mode: 'full'           → stocke brut (entreprise sans DCP)
    │    store_mode: 'auto'           → détecte + anonymise si DCP détectées
    │    store_mode: 'anonymized'     → anonymise systématiquement (toujours)
    │
    ▼
model PromptRecord (Postgres local)
```

---

## Configuration (`orchestrator.yaml`)

```yaml
prompt_store:
  enabled: true
  store_mode: auto        # off | full | auto | anonymized
  # Quels champs stocker
  store_system_prompt: true
  store_user_prompt: true
  store_llm_response: true
  # Détection PII
  pii_detection:
    enabled: true
    # Seuil de score Presidio (0–1) au-dessus duquel une entité est considérée détectée
    confidence_threshold: 0.7
    # Regex patterns supplémentaires (en plus des patterns intégrés)
    custom_patterns: []
  # Rétention
  retention_days: 30       # purge automatique via cron (même mécanique que run-data-ttl)
  # Limite taille (éviter des prompts de 200k tokens en DB)
  max_chars_per_field: 50000
```

---

## Détection PII — `lib/privacy/detector.ts`

### Stratégie en couches

```
Couche 1 — Regex intégrés (synchrone, 0 dépendance)
  ├── Email :              /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
  ├── Téléphone FR/EU :    /(?:\+33|0033|0)[1-9](?:[\s.\-]?\d{2}){4}/g
  ├── IBAN :               /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g
  ├── Carte bancaire :     /\b(?:\d{4}[\s\-]?){3}\d{4}\b/g
  ├── SIRET/SIREN :        /\b\d{9}(?:\s?\d{5})?\b/g
  ├── Numéro sécu FR :     /\b[12]\s?\d{2}\s?\d{2}\s?\d{2,3}\s?\d{3}\s?\d{3}\s?\d{2}\b/g
  ├── IPv4 privées/ext :   /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  └── Custom patterns :    depuis orchestrator.yaml

Couche 2 — Presidio (optionnel, async, si presidio.enabled = true dans orchestrator.yaml)
  ├── NER : PERSON, EMAIL_ADDRESS, PHONE_NUMBER, LOCATION, IBAN_CODE, etc.
  └── Filtré à confidence >= pii_detection.confidence_threshold
```

### Interface

```ts
export interface PiiEntity {
  type:       string   // 'EMAIL' | 'PHONE' | 'IBAN' | 'PERSON' | 'CREDIT_CARD' | ...
  start:      number   // offset dans le texte original
  end:        number
  value:      string   // valeur détectée (pour anonymisation)
  confidence: number   // 0–1 (1.0 pour regex exact)
  source:     'regex' | 'presidio'
}

export interface PiiDetectionResult {
  hasPii:   boolean
  entities: PiiEntity[]
  score:    number   // max confidence parmi les entités
}

export async function detectPii(
  text:    string,
  options: PiiDetectionOptions,
): Promise<PiiDetectionResult>
```

### Détection "RGPD applicable ?"

Le RGPD s'applique dès qu'une DCP est présente. `hasPii` est le signal.

```ts
// Décision dans recorder.ts
if (cfg.store_mode === 'auto') {
  const result = await detectPii(text, getCfg())
  if (result.hasPii) {
    // → anonymiser avant de stocker
    text = anonymize(text, result.entities)
    stored_as = 'anonymized'
  } else {
    // → stocker brut (pas de DCP détectées)
    stored_as = 'full'
  }
}
```

---

## Anonymisation — `lib/privacy/anonymizer.ts`

### Stratégie : remplacement par labels consistants

L'anonymisation remplace chaque entité par un label stable au sein du texte,
permettant l'analyse des patterns sans exposer les valeurs réelles.

```
"Envoyez le rapport à jean.dupont@acme.fr avant vendredi"
     → "Envoyez le rapport à [EMAIL_1] avant vendredi"

"Contactez M. Dupont au 06 12 34 56 78 ou Mme Martin au 07 98 76 54 32"
     → "Contactez M. [PERSON_1] au [PHONE_1] ou Mme [PERSON_2] au [PHONE_2]"
```

Les labels sont numérotés par type dans l'ordre d'apparition. Si la même valeur
réapparaît, elle reçoit le même label (consistance intra-document).

### Interface

```ts
export function anonymize(text: string, entities: PiiEntity[]): string
```

Implémentation : tri des entités par offset décroissant → remplacement de droite
à gauche pour éviter le décalage des indices.

---

## Modèle Prisma — `PromptRecord`

```prisma
// ─── Prompt Store (Amendment 93) ─────────────────────────────────────────────
// Optional full-prompt storage for self-improvement analysis.
// Controlled by orchestrator.yaml → prompt_store.store_mode.
// When store_mode='auto': only stored if no PII detected (or after anonymization).
// NOT related to PromptSummary (Am.86) — that table stores only metadata.

model PromptRecord {
  id             String   @id @default(uuid())
  run_id         String
  node_id        String   // DAG node_id "n1", "n2"
  agent_type     String
  llm_profile_id String?
  // Content fields — may be anonymized (check stored_as)
  system_prompt  String?   // may be truncated to max_chars_per_field
  user_prompt    String?
  llm_response   String?
  // Provenance
  stored_as      String   @default("full")  // full | anonymized
  pii_detected   Boolean  @default(false)   // true if PII was found before storing
  pii_entity_types String[] // detected entity type labels e.g. ["EMAIL", "PHONE"]
                             // (types only — values are NOT stored)
  // Perf metadata (feeds self-improvement analyzer)
  tokens_in      Int?
  tokens_out     Int?
  duration_ms    Int?
  // Lifecycle
  created_at     DateTime @default(now())
  expires_at     DateTime // created_at + retention_days

  @@index([run_id])
  @@index([agent_type, llm_profile_id])
  @@index([expires_at])
  @@index([pii_detected])
}
```

---

## Phases d'implémentation

### Phase 1 — Prisma + config

- `prisma/schema.prisma` : ajouter `PromptRecord`
- `lib/prompt-store/config.ts` : lire `prompt_store` depuis `orchestrator.yaml`
- `orchestrator.yaml` : ajouter le bloc `prompt_store`
- Migration : `npx prisma migrate dev --name add_prompt_record`

### Phase 2 — Détection PII

- `lib/privacy/detector.ts` : regex layer + Presidio hook
- `lib/privacy/presidio-client.ts` : appel HTTP vers Presidio si `presidio.enabled`
  (Presidio est déjà dans `docker-compose.yml` ou peut y être ajouté comme service optionnel)
- Tests : `tests/privacy/detector.test.ts` — cas "email seul", "IBAN", "nom propre",
  "texte 100% technique sans DCP"

### Phase 3 — Anonymisation

- `lib/privacy/anonymizer.ts` : remplacement par labels
- Tests : `tests/privacy/anonymizer.test.ts` — idempotence, consistance des labels,
  gestion des overlaps

### Phase 4 — Recorder

- `lib/prompt-store/recorder.ts` : `recordPrompt(input)` — applique la logique
  `store_mode` + détection + anonymisation + insert en DB
- Brancher dans `lib/agents/writer.ts`, `lib/agents/reviewer.ts`,
  `lib/agents/planner.ts` après chaque exécution de nœud

### Phase 5 — Extension du self-improvement analyzer (Am.92)

Quand `PromptRecord` est disponible, enrichir `computeInstanceMetrics()` avec :
- `avgPromptLength` par agent_type (détecter les prompts trop longs → truncation)
- `piiRateByProject` — taux de détection de DCP par projet (signal pour l'opérateur)
- `llmResponseLength` distribution (détecter les outputs trop courts = refus silencieux)

### Phase 6 — UI Admin (visualisation)

- `app/(app)/admin/prompt-store/page.tsx` : tableau des `PromptRecord`
  - Filtres : run_id, agent_type, stored_as, pii_detected
  - Affichage des champs tronqués (max 500 chars preview)
  - Badge "anonymisé" / "brut" / "PII détectée"
- Route API : `GET /api/admin/prompt-store/records` (instance_admin)
- Route API : `DELETE /api/admin/prompt-store/records` (purge manuelle — instance_admin)

### Phase 7 — OpenAPI + i18n

- `openapi/v1.yaml` : documenter `PromptRecord` et les routes admin
- `locales/en.json` + `locales/fr.json` : clés `admin.prompt_store.*`

---

## Intégration Presidio (optionnel)

Presidio est un outil Microsoft (open-source) de détection et anonymisation de PII.
Il tourne comme un service HTTP local (port 5001 par défaut).

Ajout dans `docker-compose.yml` :

```yaml
presidio-analyzer:
  image: mcr.microsoft.com/presidio-analyzer:latest
  ports:
    - "5001:3000"
  environment:
    - PRESIDIO_LOG_LEVEL=WARNING
  profiles:
    - pii   # opt-in profile — démarré seulement si COMPOSE_PROFILES=pii
```

Config `orchestrator.yaml` :

```yaml
privacy:
  presidio:
    enabled: true
    base_url: http://presidio-analyzer:3000
    timeout_ms: 2000    # fallback regex si Presidio dépasse ce délai
    language: fr        # fr | en | auto (détecte la langue du texte)
```

Si Presidio n'est pas disponible (timeout ou `enabled: false`), le fallback regex
s'applique automatiquement — le système ne bloque jamais l'exécution d'un nœud.

---

## Contraintes de sécurité

| Contrainte | Mise en œuvre |
|-----------|---------------|
| Pas de transmission externe | `detectPii()` et `anonymize()` sont locaux. Presidio tourne dans le même Docker network. |
| Valeurs PII jamais stockées | `pii_entity_types` stocke les types (EMAIL, PHONE), jamais les valeurs détectées. |
| Store off par défaut si Electron | `store_mode: 'off'` forcé si `deployment_mode !== 'docker'`. |
| TTL obligatoire | `expires_at` est calculé à l'insertion : `created_at + retention_days`. Pas de PromptRecord éternel. |
| Accès admin uniquement | Routes `/api/admin/prompt-store/` requièrent `admin:*`. |
| Taille max | `max_chars_per_field` (défaut 50 000 chars) — tronque avant insertion pour éviter > 200 MB. |
| Suppression User | `PromptRecord` n'a pas de FK vers `User` — pas de blocage. Si besoin de purge RGPD: `DELETE WHERE run_id IN (SELECT id FROM Run WHERE created_by = userId)`. |

---

## Décision `store_mode` par déploiement

| Déploiement | Recommandation | Raison |
|------------|----------------|--------|
| Entreprise interne, données 100% techniques | `full` | Pas de DCP → analyse maximum |
| Entreprise mixte (données clients potentielles) | `auto` | Détection + anonymisation si DCP |
| Secteur santé / juridique / RH | `anonymized` | Toujours anonymiser, peu importe |
| RGPD strict, préférence minimisation | `off` | Pas de stockage prompt du tout |

---

## Checklist pré-merge

- [ ] `npx tsc --noEmit` — 0 erreurs
- [ ] `npx prisma migrate dev --name add_prompt_record`
- [ ] `npx prisma generate`
- [ ] Tests `tests/privacy/detector.test.ts` et `tests/privacy/anonymizer.test.ts`
- [ ] `store_mode: 'off'` forcé si `deployment_mode !== 'docker'`
- [ ] `pii_entity_types` ne contient jamais de valeurs, seulement des types
- [ ] `expires_at` toujours calculé à l'insertion
- [ ] Routes admin : 401/403 sur accès non-admin
- [ ] `openapi/v1.yaml` mis à jour — routes + schéma `PromptRecord`
- [ ] `locales/en.json` + `locales/fr.json` mis à jour
