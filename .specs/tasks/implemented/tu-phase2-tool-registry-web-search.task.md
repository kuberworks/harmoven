---
title: "TU-Phase2 — Tool registry + Web search executor"
spec: .specs/tasks/draft/llm-tool-use-web-search.feature.md#partie-3
depends_on: [tu-phase1-llm-core-tools]
created: 2026-04-08
status: todo
round: 2
branch: feat/tu-phase2-tool-registry-web-search
---

## Objectif

Créer le registry des outils et l'exécuteur de recherche web (Brave, Tavily, DuckDuckGo).
Pas encore injecté dans le runner — c'est TU-Phase3. Ce module est pur : aucun agent ne change.

---

## Prérequis

Branche `feat/tu-phase1-llm-core-tools` mergée dans `develop`.
(Fournit `ToolDefinition`, `ToolCall`, `ToolResult`, `ILLMClient.tools?`)

---

## Spec de référence

- **Partie 3 §3.1 à §3.4** — structure répertoire, `WEB_SEARCH_TOOL`, `makeWebSearchExecutor()`, providers
- **Partie 7 §7.1 à §7.5** — SSRF guard, prompt injection, rate limiting per-project
- **Partie 6 §6.1** — env vars requis

---

## Fichiers à créer

### 1. `lib/agents/tools/registry.ts`

Voir spec §3.2. Définir `WEB_SEARCH_TOOL: ToolDefinition` avec :
- `name: 'web_search'`
- description complète indiquant "current, real-time information"
- `input_schema: { query: string (required), max_results: integer (optional, 1-10) }`

### 2. `lib/agents/tools/web-search.ts`

Voir spec §3.3. Implémenter exactement :

#### Providers
- **`searchBrave()`** : `GET https://api.search.brave.com/res/v1/web/search` + `X-Subscription-Token: process.env.BRAVE_SEARCH_API_KEY`
- **`searchTavily()`** : `POST https://api.tavily.com/search` + `api_key: process.env.TAVILY_API_KEY`
- **`searchDuckDuckGo()`** : HTML scraping `https://lite.duckduckgo.com/lite/` — User-Agent : `Mozilla/5.0 (compatible; research-assistant/1.0)` (ne pas révéler le hostname)

#### `makeWebSearchExecutor(runConfig, db, nodeCtx)`
Retourne un `toolExecutor` compatible `ChatOptions.toolExecutor`. Respecter :
- SSRF guard `assertNotPrivateHost()` sur chaque URL de résultat
- Retry 1× avec backoff 1s sur erreur réseau
- Log dans `db.sourceTrustEvent.createMany()` (modèle existant, `source_type: 'web_search'`)
- Dégradation gracieuse : si provider unavailable → `ToolResult` avec `is_error: true` + message non technique
- Jamais throw vers l'appelant

#### Rate limiting per-project — voir spec §7.5

```ts
// Limiter à 60 recherches/heure par project_id
const rateLimitMap = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(projectId: string): void {
  const now = Date.now()
  const entry = rateLimitMap.get(projectId)
  if (!entry || now - entry.windowStart > 3_600_000) {
    rateLimitMap.set(projectId, { count: 1, windowStart: now })
    return
  }
  if (entry.count >= 60) {
    throw new Error('Web search rate limit exceeded (60/hour per project)')
  }
  entry.count++
}
```

#### Sanitisation prompt injection dans résultats — voir spec §7.2

```ts
// Envelopper les résultats web dans un tag de confiance pour que le LLM
// sache qu'il s'agit de données externes non-fiables
function wrapResultContent(content: string): string {
  return `<WEB_SEARCH_RESULT>\n${content}\n</WEB_SEARCH_RESULT>`
}
```

### 3. `lib/agents/tools/index.ts`

```ts
export { WEB_SEARCH_TOOL } from './registry'
export { makeWebSearchExecutor } from './web-search'
export type { WebSearchResultItem, WebSearchResponse } from './web-search'
```

### 4. Tests — `tests/agents/tools/web-search.test.ts` — NOUVEAU

Mocker `fetch`. Couvrir :
- `searchBrave()` → parse résultats correctement
- `searchBrave()` sans `BRAVE_SEARCH_API_KEY` → throw
- `searchDuckDuckGo()` → parse HTML minimal
- `makeWebSearchExecutor()` : call `'web_search'` → retourne `ToolResult` formatté
- `makeWebSearchExecutor()` : call inconnu → `is_error: true`
- `makeWebSearchExecutor()` : provider unavailable → `is_error: true` sans throw
- Rate limit : 61ème appel sur même project_id dans la même heure → `is_error: true`
- SSRF : URL résultat pointant vers `localhost` → filtrée silencieusement

**Important sécurité SSRF :** les URLs de résultats de recherche proviennent du LLM/provider — toujours passer par `assertNotPrivateHost()`.

---

## Variables d'environnement requises (à documenter dans `.env.example`)

```
# Web search providers (au moins un requis si enable_web_search activé)
BRAVE_SEARCH_API_KEY=        # Brave Search API — https://api.search.brave.com
TAVILY_API_KEY=              # Tavily — https://tavily.com
# DuckDuckGo ne nécessite pas de clé API (mode dégradé, sans quota)
WEB_SEARCH_PROVIDER=brave    # brave | tavily | duckduckgo (défaut: brave)
```

---

## Critères de validation

- [ ] `makeWebSearchExecutor()` sans clé Brave → `ToolResult.is_error = true` (pas de throw)
- [ ] `searchDuckDuckGo()` avec fetch mocké → parse ≥1 résultat
- [ ] URL de résultat `http://localhost` → filtrée (SSRF guard)
- [ ] Rate limit 60/h par project_id : 61ème appel → `is_error: true`
- [ ] Résultats wrappés dans `<WEB_SEARCH_RESULT>...</WEB_SEARCH_RESULT>`
- [ ] `npx tsc --noEmit` zéro erreur
- [ ] Nouveaux tests verts, existants passent

---

## Commit

```
feat(tools): web search executor with Brave, Tavily, DuckDuckGo providers

- lib/agents/tools/registry.ts: WEB_SEARCH_TOOL ToolDefinition
- lib/agents/tools/web-search.ts: makeWebSearchExecutor() + providers + rate limit + SSRF
- lib/agents/tools/index.ts: barrel exports
- tests/agents/tools/web-search.test.ts: providers, rate limit, SSRF, error handling
```
