---
title: "GitHub Models — provider LLM via token GitHub (GPT-4o, Llama, etc.)"
status: draft
created: 2026-04-15
depends_on: []
agents_completed: []
agents_pending: [implementer]
---

## Ce que c'est vraiment

L'utilisateur dit "GitHub Copilot comme LLM". En réalité il existe deux produits :

| Produit | Ce que c'est | API officielle |
|---|---|---|
| **GitHub Copilot** | Autocomplétion de code dans l'IDE | Non (usage perso IDE seulement) |
| **GitHub Models** | Marketplace d'inférence AI (GPT-4o, Claude, Llama…) | **Oui** — OpenAI-compatible |

**On intègre GitHub Models.** Un abonnement Copilot Pro/Business donne de meilleurs rate limits, mais ce n'est pas obligatoire — un compte GitHub gratuit suffit pour démarrer.

---

## ⚠️ Limites à communiquer CLAIREMENT à l'utilisateur non-technique

> **GitHub Models n'est pas viable comme provider principal en production.**

| Plan | Requêtes/jour (modèles "High") | Contexte max | Tokens max en sortie |
|---|---|---|---|
| Copilot Free | 50 req/jour | 8 000 tokens | 4 000 tokens |
| Copilot Pro | 50 req/jour | 8 000 tokens | 4 000 tokens |
| Copilot Business | 100 req/jour | 8 000 tokens | 4 000 tokens |
| Copilot Enterprise | 150 req/jour | 16 000 tokens | 8 000 tokens |

**Ce que ça signifie concrètement pour un utilisateur d'Harmoven :**
- Un run complet = 4–8 appels LLM (classifieur + planneur + 1–3 writer + 1–2 reviewer)
- **Copilot Free = 6–12 runs/jour maximum** avec les modèles performants
- **4 000 tokens en sortie** = ~3 000 mots — les documents longs seront tronqués
- **8 000 tokens de contexte** = pas d'historique long ni de fichiers volumineux

**Pour qui c'est utile :**
- ✅ Dev et tests sans dépenser
- ✅ Utilisateurs qui ont déjà GitHub et ne veulent pas créer de compte Anthropic/OpenAI
- ✅ Accès à Llama 3.3 70B (open source) sans infrastructure locale
- ❌ Production sérieuse avec >10 runs/jour (utiliser Anthropic, OpenAI, ou CometAPI)

---

## Architecture retenue — pourquoi c'est simple

GitHub Models expose `https://models.github.ai/inference/chat/completions` — **exactement la même interface que OpenAI**. Le code Harmoven réutilise `callOpenAI()` à 100 %. La seule vraie nouveauté : GitHub exige un header supplémentaire (`X-GitHub-Api-Version: 2022-11-28`).

Il n'existe **pas** de façon plus simple que d'ajouter ce header dans le constructeur OpenAI :
```ts
new OpenAI({
  apiKey:         githubToken,
  baseURL:        'https://models.github.ai/inference',
  defaultHeaders: { 'X-GitHub-Api-Version': '2022-11-28' },
})
```

**Changements requis :**
1. `LlmProfileConfig` : ajouter `extra_headers?: Record<string, string>` (5 lignes)
2. `buildOpenAIClient()` : passer `defaultHeaders` (2 lignes)
3. `lib/llm/client.ts` switch : `case 'github'` (1 ligne)
4. `BUILT_IN_PROFILES` : 3–4 profils pré-configurés (non-bloquant — l'admin peut créer manuellement)
5. Admin UI : ajouter `'github'` dans la liste des providers (1 mot)
6. `openapi/v1.yaml` : documenter le provider `github`

**Aucune nouvelle dépendance. Aucune migration Prisma.**

---

## Implémentation

### Phase 1 — `LlmProfileConfig` + `buildOpenAIClient`

**Fichier : `lib/llm/profiles.ts`**

Dans l'interface `LlmProfileConfig`, après `supports_tool_choice` :

```ts
/**
 * Additional HTTP headers sent with every request (e.g. X-GitHub-Api-Version).
 * Passed as `defaultHeaders` to the OpenAI constructor.
 * Used by the `github` provider.
 */
extra_headers?: Record<string, string>
```

**Fichier : `lib/llm/client.ts`** — dans `buildOpenAIClient()` :

```ts
const client = new OpenAI({
  apiKey,
  ...(profile.base_url       ? { baseURL:        profile.base_url       } : {}),
  ...(profile.extra_headers  ? { defaultHeaders: profile.extra_headers  } : {}),  // ← nouveau
})
```

Dans les deux blocs `switch (profile.provider)` (`.chat()` et `.stream()`) :

```ts
case 'github': return callOpenAI(profile, messages, options)   // OpenAI-compat
```

---

### Phase 2 — Profils built-in

**Fichier : `lib/llm/profiles.ts`**

Ajouter dans `BUILT_IN_PROFILES` :

```ts
// ── GitHub Models — https://github.com/marketplace/models ─────────────────
// Auth : GITHUB_TOKEN (PAT avec scope "models", ou GITHUB_TOKEN depuis Actions).
// Base URL : https://models.github.ai/inference (pas de /v1 — GitHub le gère)
// Les model_string incluent le préfixe provider GitHub : openai/*, meta/*, etc.
//
// ⚠️  RATE LIMITS (free / Copilot Free) :
//   - "Low" models (gpt-4o-mini) : 15 RPM, 150 req/jour, 4 000 tokens sortie
//   - "High" models (gpt-4.1)    : 10 RPM,  50 req/jour, 4 000 tokens sortie
// Copilot Enterprise : 2-3× plus de quota.
// Non recommandé comme provider principal en production.
{
  id:                       'github-gpt-4o-mini',
  provider:                 'github',
  model_string:             'openai/gpt-4o-mini',
  tier:                     'fast',
  context_window:           128_000,
  cost_per_1m_input_tokens:  0,   // gratuit sur quota journalier ; prix variable au-delà
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               1,
  task_type_affinity:       ['intent_classification', 'simple_tasks'],
  base_url:                 'https://models.github.ai/inference',
  api_key_env:              'GITHUB_TOKEN',
  max_output_tokens:        4_000,  // limite GitHub Models — tier "Low"
  extra_headers: {
    'X-GitHub-Api-Version': '2022-11-28',
  },
},
{
  id:                       'github-gpt-4.1',
  provider:                 'github',
  model_string:             'openai/gpt-4.1',
  tier:                     'powerful',
  context_window:           128_000,
  cost_per_1m_input_tokens:  0,
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               1,
  task_type_affinity:       ['complex_reasoning', 'review', 'planning'],
  base_url:                 'https://models.github.ai/inference',
  api_key_env:              'GITHUB_TOKEN',
  max_output_tokens:        4_000,  // limite GitHub Models — tier "High", free
  extra_headers: {
    'X-GitHub-Api-Version': '2022-11-28',
  },
},
{
  id:                       'github-llama-3.3-70b',
  provider:                 'github',
  model_string:             'meta/Llama-3.3-70B-Instruct',
  tier:                     'balanced',
  context_window:           128_000,
  cost_per_1m_input_tokens:  0,
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               2,
  task_type_affinity:       ['writing', 'analysis'],
  base_url:                 'https://models.github.ai/inference',
  api_key_env:              'GITHUB_TOKEN',
  max_output_tokens:        4_000,
  extra_headers: {
    'X-GitHub-Api-Version': '2022-11-28',
  },
},
```

Mettre à jour le commentaire d'en-tête du fichier ligne ~7 :
```ts
// Provider routing: 'anthropic' | 'openai' | 'gemini' | 'cometapi' | 'ollama' | 'github'
```

---

### Phase 3 — Admin UI

**Fichier : `app/(app)/admin/models/models-client.tsx`**

Ligne 86 — ajouter `'github'` dans `PROVIDERS` :
```ts
const PROVIDERS = ['anthropic', 'openai', 'gemini', 'cometapi', 'ollama', 'mistral', 'github', 'custom']
```

> **Pas de champ "extra_headers" dans l'UI** — ce champ est uniquement pour les
> profils built-in. Un utilisateur qui veut ajouter un profil GitHub Models
> manuellement passe par le provider `custom` avec `base_url` + `api_key_env`.
> Le champ `extra_headers` ne peut pas encore être édité depuis l'UI admin : il
> est sérialisé dans le JSON config de la DB à la création (`seedMissingProfilesToDb`).
> 
> Si on veut permettre l'édition depuis l'UI à terme, c'est une tâche séparée.

---

### Phase 4 — `dbRowToLlmProfileConfig`

**Fichier : `lib/llm/profiles.ts`**

Dans `dbRowToLlmProfileConfig()`, lire `extra_headers` depuis le JSON `config` :

```ts
extra_headers: typeof config['extra_headers'] === 'object' && config['extra_headers'] !== null
  ? (config['extra_headers'] as Record<string, string>)
  : undefined,
```

Également dans `seedMissingProfilesToDb()`, sauvegarder `extra_headers` dans le JSON config :

```ts
config: JSON.stringify({
  base_url:      p.base_url,
  api_key_env:   p.api_key_env,
  max_output_tokens: p.max_output_tokens,
  extra_headers: p.extra_headers,   // ← nouveau
}),
```

---

### Phase 5 — OpenAPI + i18n

**`openapi/v1.yaml`**

Ajouter `github` dans le type `LlmProviderEnum` (ou équivalent). Dans la description
du champ `provider` dans `LlmProfileCreate` :

```yaml
description: >
  ...
  `github` — GitHub Models (models.github.ai) — compatible OpenAI, 
  requiert GITHUB_TOKEN avec scope "models". Rate-limité.
```

**i18n** — `locales/en.json` + `locales/fr.json` :

Pas de chaîne d'UI visible à ajouter si `github` apparaît simplement comme une option
dans la liste déroulante de provider (la valeur s'affiche telle quelle).

Si un tooltip ou warning doit être affiché dans l'admin sur la rate-limit, ajouter :
```json
"admin.models.provider.github.warning": "Rate-limited: ~50 req/day on free tier. Not suitable for production.",
"admin.models.provider.github.warning_fr": "Limité : ~50 req/jour sur compte gratuit. Déconseillé en production."
```

---

## Ce qui est hors scope

- Afficher un warning dans l'admin quand le provider sélectionné est `github` (UX nice-to-have, dans une tâche séparée)
- Ajouter un champ `extra_headers` éditables depuis l'UI admin (tâche séparée)
- Support de l'API GitHub Copilot (`api.githubcopilot.com`) — endpoint non-officiel, comportement non garanti
- Auto-détection du quota restant (GitHub n'expose pas de headers X-RateLimit-Remaining sur cet endpoint)

---

## Critères d'acceptation

- [ ] `LlmProfileConfig` a le champ `extra_headers?: Record<string, string>`
- [ ] `buildOpenAIClient()` passe `defaultHeaders` quand `extra_headers` est défini
- [ ] `switch(profile.provider)` dans `.chat()` et `.stream()` : `case 'github'` → `callOpenAI()`
- [ ] 3 profils built-in dans `BUILT_IN_PROFILES` : `github-gpt-4o-mini`, `github-gpt-4.1`, `github-llama-3.3-70b`
- [ ] `dbRowToLlmProfileConfig()` lit `extra_headers` depuis le config JSON
- [ ] `seedMissingProfilesToDb()` persiste `extra_headers` dans le config JSON
- [ ] `PROVIDERS` dans l'admin UI inclut `'github'`
- [ ] `npx tsc --noEmit` passe sans erreur
- [ ] `npx jest --passWithNoTests --no-coverage` passe
- [ ] Avec `GITHUB_TOKEN` valide : un run complet avec `github-gpt-4o-mini` se termine sans erreur

---

## Points de vigilance — faits vérifiés

1. **Endpoint complet** : `https://models.github.ai/inference/chat/completions`
   → `base_url` = `https://models.github.ai/inference` (l'OpenAI SDK ajoute `/chat/completions`)
   → **Pas de `/v1`** dans la base URL — contrairement à CometAPI/Ollama qui ont `/v1`

2. **Format du `model_string`** : préfixé par le fournisseur — `openai/gpt-4.1`, `meta/Llama-3.3-70B-Instruct`.
   Le SDK OpenAI passe ce string verbatim à l'API — aucun traitement nécessaire.

3. **Header obligatoire** : `X-GitHub-Api-Version: 2022-11-28` — requis selon la doc officielle GitHub.
   Sans ce header, l'API peut retourner des erreurs ou des réponses inattendues.

4. **Token et scope** : PAT classique (Fine-grained ou Classic) avec scope `models`.
   Le `GITHUB_TOKEN` automatique dans GitHub Actions a aussi ce scope si
   `permissions: models: read` est déclaré dans le workflow.

5. **SSRF** : `models.github.ai` est public → passe `validateLLMBaseUrl()` sans modification.

6. **`max_output_tokens: 4_000`** — valeur vérifiée dans la table de rate limits GitHub
   (Copilot Free, High-tier models). En mode Copilot Enterprise : 8 000 tokens max.
   Le champ `max_output_tokens` dans Harmoven clamp déjà correctement via `Math.min()`.

---

## Guide utilisateur non-technique (à inclure dans la doc Harmoven)

```
1. Allez sur github.com/settings/tokens → "Generate new token (classic)"
2. Cochez UNIQUEMENT le scope "models" (nom exact : "models")
3. Copiez le token (commence par ghp_...)
4. Dans votre fichier .env de Harmoven, ajoutez :
   GITHUB_TOKEN=ghp_votre_token_ici
5. Redémarrez Harmoven
6. Dans l'interface admin → Modèles, les profils "GitHub GPT-4o mini",
   "GitHub GPT-4.1" et "GitHub Llama 3.3 70B" apparaissent.
   Activez ceux que vous voulez utiliser.
7. Dans orchestrator.yaml, ajoutez l'un de ces profils dans profiles_active.

⚠️ Attention : avec un compte GitHub gratuit, vous êtes limité à
environ 50 requêtes par jour sur les modèles performants,
ce qui correspond à 5-10 tâches Harmoven. C'est parfait pour
tester, pas pour un usage quotidien intensif.
```
