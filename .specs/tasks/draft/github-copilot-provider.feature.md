---
title: "GitHub Copilot LLM provider — plugin Harmoven non officiel"
status: implemented
created: 2026-04-15
implemented: 2026-04-15
depends_on: []
agents_completed: [implementer]
agents_pending: []
---

## ⚠️ Avertissement préalable — ToS et stabilité

> **Cet endpoint n'est pas une API publique GitHub.**

`api.githubcopilot.com/chat/completions` est l'endpoint interne utilisé par
l'extension VS Code GitHub Copilot. GitHub ne publie pas de documentation
officielle pour un usage tiers. Utiliser cet endpoint dans une application
comme Harmoven peut :

1. **Violer les CGU GitHub Copilot** — le service est licencié comme outil
   d'assistance au développement dans des environnements supportés (IDE).
2. **Entraîner une suspension de compte** GitHub si les volumes ou patterns sont
   détectés comme anormaux.
3. **Casser sans préavis** — endpoint interne = peut changer à tout moment.

**Usage recommandé : dev/test personnel uniquement.** Ne pas déployer sur une
instance Harmoven partagée ni en production avec des utilisateurs tiers.

---

## Pourquoi ça vaut quand même la peine

- Claude Sonnet 4.6 disponible avec **multiplicateur 1×** (= 1 premium request/appel)
- Plans Copilot Pro : ~300 premium requests/mois incluses
- Plans Copilot Business/Enterprise : 300–500+ premium requests/mois
- **Zéro facturation supplémentaire** si dans le quota mensuel
- Claude Haiku 4.5 à **0.33×** (très peu coûteux en quota)

---

## Flux d'authentification (reverse-engineered de l'extension VS Code)

Le flow en deux étapes est documenté dans des projets open source
(`copilot-api`, `copilot.vim`, etc.) :

```
┌──────────────────────────────────────────────────────────┐
│ 1. GitHub PAT (classic, scope: copilot)                  │
│    → GET https://api.github.com/copilot_internal/v2/token│
│    ← { token: "ghu_...", expires_at: "2026-..." }        │
│       TTL ≈ 30 minutes                                    │
│                                                           │
│ 2. Token interne (30 min TTL, auto-refresh)              │
│    → POST https://api.githubcopilot.com/chat/completions  │
│       Authorization: Bearer <copilot_token>              │
│       Editor-Version: vscode/1.97.2                      │
│       Copilot-Integration-Id: vscode-chat                │
│    ← { choices: [...] }  (format OpenAI-compatible)      │
└──────────────────────────────────────────────────────────┘
```

**Format des model_string** — différent de GitHub Models :
```
claude-sonnet-4-5        (pas anthropic/claude-sonnet-4-5)
claude-haiku-4-5
gpt-4o
gpt-4o-mini
gemini-2.0-flash
```

---

## Architecture retenue

**Nouveau fichier : `lib/llm/copilot-client.ts`**

Isoler complètement la logique Copilot dans son propre module pour :
- Ne pas polluer `client.ts`
- Pouvoir supprimer facilement si l'API change
- Token refresh indépendant du cache OpenAI

```
DirectLLMClient.chat()/.stream()
    switch (profile.provider)
        case 'copilot' → callCopilot() dans copilot-client.ts
```

---

## Implémentation

### Phase 1 — `lib/llm/copilot-client.ts` (nouveau fichier)

```ts
// lib/llm/copilot-client.ts
// UNOFFICIAL: uses GitHub Copilot internal API (api.githubcopilot.com).
// This is NOT a GitHub-supported public API. See spec for ToS implications.
//
// Auth flow:
//   1. GitHub PAT (GITHUB_COPILOT_PAT env var, scope: copilot)
//      → https://api.github.com/copilot_internal/v2/token
//      ← { token, expires_at }   (TTL ≈ 30 min)
//   2. copilot_token
//      → https://api.githubcopilot.com/chat/completions
//      Headers: Editor-Version, Copilot-Integration-Id
//      ← OpenAI-format JSON

import OpenAI from 'openai'
import type { LlmProfileConfig }    from './profiles'
import type { ChatMessage, ChatOptions, ChatResult } from './interface'
import { runOpenAIToolLoop } from './client'

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const COPILOT_BASE_URL  = 'https://api.githubcopilot.com'

// ─── Internal token cache (one per PAT) ────────────────────────────────────────

interface CopilotTokenEntry {
  token:      string
  expiresAt:  number  // epoch ms — refresh 60s before expiry
}

// Key = GITHUB_COPILOT_PAT value (first 8 chars = sufficient for cache key)
const _tokenCache = new Map<string, CopilotTokenEntry>()

async function getCopilotToken(githubPat: string): Promise<string> {
  const cacheKey = githubPat.slice(0, 12)
  const cached   = _tokenCache.get(cacheKey)
  // Refresh 60 seconds before expiry
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const resp = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization:  `Bearer ${githubPat}`,
      'User-Agent':   'GitHubCopilotChat/0.24.0',
      Accept:         'application/json',
    },
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(
      `[CopilotClient] Token exchange failed (${resp.status}): ${body.slice(0, 200)}`,
    )
  }

  const data = (await resp.json()) as { token: string; expires_at: string }
  if (!data.token) throw new Error('[CopilotClient] Token exchange: no token in response')

  const expiresAt = new Date(data.expires_at).getTime()
  _tokenCache.set(cacheKey, { token: data.token, expiresAt })
  return data.token
}

// ─── Build ephemeral OpenAI client with copilot token ─────────────────────────

async function buildCopilotOpenAIClient(profile: LlmProfileConfig): Promise<OpenAI> {
  const pat = process.env[profile.api_key_env ?? 'GITHUB_COPILOT_PAT']
  if (!pat) {
    throw new Error(
      `[CopilotClient] ${profile.api_key_env ?? 'GITHUB_COPILOT_PAT'} is not set. ` +
      'Create a GitHub PAT (classic) with the "copilot" scope.',
    )
  }

  const copilotToken = await getCopilotToken(pat)

  // Build a new OpenAI client with the short-lived copilot token each time.
  // We don't cache this client because the token expires in ~30 min — the
  // getCopilotToken() cache handles re-use within the TTL window.
  return new OpenAI({
    apiKey:  copilotToken,
    baseURL: COPILOT_BASE_URL,
    defaultHeaders: {
      'Editor-Version':         'vscode/1.97.2',
      'Editor-Plugin-Version':  'copilot-chat/0.24.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'Openai-Intent':          'conversation-panel',
      'X-Request-Id':           crypto.randomUUID(),
    },
  })
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function callCopilot(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
): Promise<ChatResult> {
  const client = await buildCopilotOpenAIClient(profile)
  const oaiMessages = messages.map(m => ({ role: m.role, content: m.content }))

  if (options.tools?.length && options.toolExecutor) {
    return runOpenAIToolLoop(client, profile, oaiMessages, options, options.signal)
  }

  const completion = await client.chat.completions.create(
    {
      model:      profile.model_string,
      max_tokens: Math.min(options.maxTokens ?? 4096, profile.max_output_tokens ?? 4096),
      messages:   oaiMessages,
    },
    { signal: options.signal },
  )

  const choice  = completion.choices?.[0]
  const content = choice?.message?.content ?? ''
  return {
    content,
    tokensIn:  completion.usage?.prompt_tokens     ?? 0,
    tokensOut: completion.usage?.completion_tokens ?? 0,
    costUsd:   0,
    model:     completion.model,
  }
}

export async function streamCopilot(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
  onChunk:  (chunk: string) => void,
): Promise<ChatResult> {
  const client = await buildCopilotOpenAIClient(profile)

  const stream = await client.chat.completions.create(
    {
      model:      profile.model_string,
      max_tokens: Math.min(options.maxTokens ?? 4096, profile.max_output_tokens ?? 4096),
      messages:   messages.map(m => ({ role: m.role, content: m.content })),
      stream:     true,
    },
    { signal: options.signal },
  )

  let fullText  = ''
  let modelName = profile.model_string
  let tokensIn  = 0
  let tokensOut = 0

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content ?? ''
    if (delta) {
      fullText += delta
      onChunk(delta)
    }
    if (chunk.model) modelName = chunk.model
    if (chunk.usage) {
      tokensIn  = chunk.usage.prompt_tokens     ?? 0
      tokensOut = chunk.usage.completion_tokens ?? 0
    }
  }

  return { content: fullText, tokensIn, tokensOut, costUsd: 0, model: modelName }
}

/** Invalidate the cached copilot token for a given PAT (e.g. after 401). */
export function invalidateCopilotToken(pat: string): void {
  _tokenCache.delete(pat.slice(0, 12))
}
```

---

### Phase 2 — `lib/llm/client.ts`

**Ajouter l'import** (après les imports existants) :

```ts
import { callCopilot, streamCopilot, invalidateCopilotToken } from './copilot-client'
```

**Ajouter le provider** dans le commentaire d'en-tête :
```ts
//   copilot    → lib/llm/copilot-client.ts (UNOFFICIAL — internal GitHub Copilot API)
```

**Dans le switch `.chat()`** (ligne ~901) :
```ts
case 'copilot': return callCopilot(profile, messages, options)
```

**Dans le switch `.stream()`** :
```ts
case 'copilot': return streamCopilot(profile, messages, options, onChunk)
```

**Sur les 401** — ajouter un try/catch autour des appels `copilot` pour
invalider le token et réessayer une fois :
```ts
// Dans le catch du bloc switch stream/chat pour provider copilot :
if (profile.provider === 'copilot' && err instanceof Error && err.message.includes('401')) {
  const pat = process.env[profile.api_key_env ?? 'GITHUB_COPILOT_PAT'] ?? ''
  invalidateCopilotToken(pat)
  // retry once
  return callCopilot(profile, messages, options)
}
```

---

### Phase 3 — Profils built-in (`lib/llm/profiles.ts`)

```ts
// ── GitHub Copilot Internal API — UNOFFICIAL, see copilot-client.ts ───────────
// Auth : GITHUB_COPILOT_PAT (classic PAT, scope "copilot")
// Token exchange : api.github.com/copilot_internal/v2/token → 30 min TTL
// ⚠️  Violates GitHub Copilot ToS if used outside personal dev environment.
// model_string format : no publisher prefix (e.g. "claude-sonnet-4-5", not "anthropic/...")
{
  id:                       'copilot-claude-sonnet-4-5',
  provider:                 'copilot',
  model_string:             'claude-sonnet-4-5',
  tier:                     'powerful',
  context_window:           200_000,
  cost_per_1m_input_tokens:  0,   // consomme 1× premium request Copilot/appel
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               1,
  task_type_affinity:       ['complex_reasoning', 'review', 'planning', 'writing'],
  api_key_env:              'GITHUB_COPILOT_PAT',
  max_output_tokens:        16_000,
},
{
  id:                       'copilot-claude-haiku-4-5',
  provider:                 'copilot',
  model_string:             'claude-haiku-4-5',
  tier:                     'fast',
  context_window:           200_000,
  cost_per_1m_input_tokens:  0,   // consomme 0.33× premium request Copilot/appel
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               1,
  task_type_affinity:       ['intent_classification', 'simple_tasks'],
  api_key_env:              'GITHUB_COPILOT_PAT',
  max_output_tokens:        8_000,
},
{
  id:                       'copilot-gpt-4o',
  provider:                 'copilot',
  model_string:             'gpt-4o',
  tier:                     'balanced',
  context_window:           128_000,
  cost_per_1m_input_tokens:  0,   // modèle inclus Copilot payant = 0 premium request
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               1,
  task_type_affinity:       ['writing', 'analysis'],
  api_key_env:              'GITHUB_COPILOT_PAT',
  max_output_tokens:        16_000,
},
```

---

### Phase 4 — Admin UI (`app/(app)/admin/models/models-client.tsx`)

Ajouter `'copilot'` dans `PROVIDERS` (ligne 86) :
```ts
const PROVIDERS = ['anthropic', 'openai', 'gemini', 'cometapi', 'ollama', 'mistral', 'copilot', 'custom']
```

---

### Phase 5 — `.env.example`

```bash
# GitHub Copilot Internal API (UNOFFICIAL — see .specs/tasks/draft/github-copilot-provider.feature.md)
# Create a classic PAT at https://github.com/settings/tokens with scope "copilot"
# Requires an active GitHub Copilot subscription (Pro, Business, or Enterprise)
# WARNING: Using this API outside of supported IDEs may violate GitHub Copilot ToS.
# GITHUB_COPILOT_PAT=ghp_your_classic_pat_here
```

---

## Ce qui est hors scope

- Invalidation automatique sur quota épuisé (pas de header `X-RateLimit-*` sur cet endpoint)
- Support du flow OAuth device flow (trop complexe — PAT suffit en self-hosted)
- Monitoring du quota premium restant (GitHub n'expose pas cet endpoint externement)
- Support des modèles qui nécessitent le mode "reasoning" (o3, o4-mini) — comportement non vérifié

---

## Critères d'acceptation

- [ ] `lib/llm/copilot-client.ts` créé avec `getCopilotToken()`, `callCopilot()`, `streamCopilot()`, `invalidateCopilotToken()`
- [ ] Token exchange `copilot_internal/v2/token` fonctionne avec un vrai PAT
- [ ] `client.ts` : `case 'copilot'` dans les deux switch (chat + stream)
- [ ] `client.ts` : retry sur 401 avec invalidation du cache token
- [ ] 3 profils built-in dans `BUILT_IN_PROFILES`
- [ ] `PROVIDERS` dans l'admin UI inclut `'copilot'`
- [ ] `GITHUB_COPILOT_PAT` documenté dans `.env.example` (commenté par défaut)
- [ ] `npx tsc --noEmit` passe sans erreur
- [ ] Avec un vrai PAT + abonnement Copilot Pro : appel réussi sur `copilot-claude-sonnet-4-5`

---

## Points de vigilance

1. **Token TTL = 30 min** — `getCopilotToken()` doit persister en mémoire entre les
   requêtes (Map module-level). Un redémarrage du serveur force un nouveau token exchange.
   En prod, cela signifie 2 appels HTTP au lieu d'1 toutes les 30 min.

2. **`crypto.randomUUID()`** dans les headers — disponible nativement en Node.js 18+.
   Harmoven tourne sur Node.js 22 — OK.

3. **`runOpenAIToolLoop` est déjà exporté** depuis `client.ts` — vérifier que
   `export async function runOpenAIToolLoop` est bien présent (ligne ~383 dans le fichier actuel).
   Si `export` manque, l'ajouter.

4. **Format `max_output_tokens`** — les valeurs (16 000 pour Sonnet, 8 000 pour Haiku)
   sont basées sur les limites connues de l'abonnement Enterprise. Sur Free/Pro,
   la limite effective peut être plus basse (non documentée officiellement).
   Si l'API retourne une erreur `max_tokens exceeds limit`, abaisser à 4 000.

5. **`X-Request-Id`** — doit être un UUID v4 unique par requête. Le `defaultHeaders`
   de l'OpenAI SDK est statique (même UUID pour toutes les requêtes de ce client).
   Si GitHub l'utilise pour le dedup, mettre à jour le header avant chaque create() :
   ```ts
   // Use request-level header override instead of defaultHeaders for X-Request-Id
   await client.chat.completions.create(..., {
     headers: { 'X-Request-Id': crypto.randomUUID() }
   })
   ```

---

## Guide utilisateur

```
1. Allez sur github.com/settings/tokens → "Generate new token (classic)"
2. Donnez-lui un nom : "Harmoven Copilot"
3. Expirationn: 90 jours ou No expiration (votre choix)
4. Cochez UNIQUEMENT : "copilot" (sous "GitHub Copilot")
5. Cliquez "Generate token"
6. Copiez le token (commence par ghp_...)
7. Dans votre .env Harmoven, décommentez et remplissez :
   GITHUB_COPILOT_PAT=ghp_votre_token_ici
8. Redémarrez Harmoven
9. Admin → Modèles : activez "Copilot Claude Sonnet 4.5" ou "Copilot Claude Haiku 4.5"
10. Dans orchestrator.yaml, ajoutez copilot-claude-sonnet-4-5 dans profiles_active

Pour que ça marche, votre compte GitHub doit avoir un abonnement GitHub Copilot actif.
```
