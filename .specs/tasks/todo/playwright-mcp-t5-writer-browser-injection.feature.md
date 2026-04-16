---
title: "Playwright MCP — T5: Writer browser injection (runner + writer + semaphore + openapi)"
status: todo
created: 2026-04-14
depends_on: [playwright-mcp-t3-mcp-remote-transport, playwright-mcp-t4-enable-browser-flow]
agents_completed: []
agents_pending: [implementer]
---

## Objectif

Injecter les outils browser dans le `ToolInjectionLLMClient` du WRITER quand
`enable_browser = true`, protéger l'accès concurrent par un semaphore 1-slot,
et documenter dans OpenAPI + i18n.

**Dépend de T3** (pour `mcpSkillClient.listToolsWithSchemas()`) et **T4**
(pour `runConfig.enable_browser` + `WriterNodeInput.browser_enabled`).

---

## Contexte — pattern web search à reproduire

Dans `lib/agents/runner.ts`, le bloc web search :
```ts
if (runConfig.enable_web_search === true) {
  tools = [WEB_SEARCH_TOOL]
  toolExecutor = makeWebSearchExecutor(...)
}
const writerClient = (tools && toolExecutor)
  ? new ToolInjectionLLMClient(captureClient, tools, toolExecutor)
  : captureClient
```

Le même pattern s'applique aux browser tools. La différence : les tool
definitions sont **dynamiques** (lues depuis le sidecar via
`listToolsWithSchemas()`) — pas une constante statique comme `WEB_SEARCH_TOOL`.

---

## Changements

### 1. `lib/agents/writer.ts`

Ajouter `browser_enabled?: boolean` à `WriterNodeInput` :

```ts
/** When true, browser tools (browser_navigate, etc.) are injected via MCP sidecar. */
browser_enabled?: boolean
```

Passer `browser_enabled` à `buildSystemPrompt` (si la fonction accepte ce paramètre)
ou ajouter une instruction dans le prompt système quand `node.browser_enabled === true`.
Vérifier la signature de `buildSystemPrompt` et étendre si nécessaire.

Exemple d'instruction à ajouter dans `buildSystemPrompt` quand `browserEnabled` :
```
BROWSER TOOLS: You have browser automation tools available (browser_navigate,
browser_snapshot, browser_click, browser_type, browser_close). Use them to
navigate real URLs, interact with web pages, and extract information.
Always close the browser session when done (browser_close).
```

### 2. `lib/agents/runner.ts`

**Semaphore 1-slot** — à déclarer en haut du module (après les imports) :

```ts
// 1-slot semaphore: only one browser session at a time (@playwright/mcp --isolated
// shares a single browser context across all MCP connections).
let _browserBusy = false
const _browserQueue: Array<() => void> = []
function acquireBrowser(): Promise<void> {
  return new Promise(resolve => {
    if (!_browserBusy) { _browserBusy = true; resolve() }
    else _browserQueue.push(resolve)
  })
}
function releaseBrowser(): void {
  const next = _browserQueue.shift()
  if (next) next()
  else _browserBusy = false
}
```

**Injection browser tools** — dans le bloc WRITER, après la section web search :

```ts
// Lecture des tool definitions depuis le sidecar MCP (dynamique)
let browserToolDefs: import('@/lib/llm/interface').ToolDefinition[] = []
let browserAcquired = false

if (runConfig.enable_browser === true) {
  try {
    const rawTools = await mcpSkillClient.listToolsWithSchemas('builtin-playwright-browser')
    browserToolDefs = rawTools.map(t => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.inputSchema as import('@/lib/llm/interface').ToolDefinition['input_schema'],
    }))
    await acquireBrowser()
    browserAcquired = true
  } catch (err) {
    // Sidecar down ou skill non activé — dégradation gracieuse, on continue sans browser.
    console.warn('[runner] browser tools unavailable:', err)
  }
}
```

**browserToolExecutor** :

```ts
if (browserToolDefs.length > 0) {
  const browserExecutor: import('@/lib/llm/interface').ChatOptions['toolExecutor']
    = async (calls) => {
      return Promise.all(calls.map(async call => {
        try {
          const content = await mcpSkillClient.callTool(
            'builtin-playwright-browser',
            call.name,
            call.input as Record<string, unknown>,
            node.run_id,
          )
          return { id: call.id, content, is_error: false }
        } catch (e) {
          return { id: call.id, content: String(e), is_error: true }
        }
      }))
    }
  // Combiner avec web search tools si les deux sont actifs
  tools        = [...(tools ?? []), ...browserToolDefs]
  toolExecutor = toolExecutor
    ? combineExecutors(toolExecutor, browserExecutor, browserToolDefs.map(t => t.name))
    : browserExecutor
}
```

> Si les deux `enable_web_search` ET `enable_browser` sont actifs, les deux sets
> d'outils coexistent dans la même `ToolInjectionLLMClient`. Implémenter
> `combineExecutors` en ligne (dispatcher par nom d'outil) ou séparer les clients
> en deux `ToolInjectionLLMClient` imbriqués — au choix de l'implémenteur.
> Solution la plus simple : deux couches de wrapping imbriquées.

**Release du semaphore** — dans le `finally` du bloc WRITER (après `result = await new Writer(...)`):

```ts
} finally {
  if (browserAcquired) releaseBrowser()
}
```

**Ajouter `browser_enabled`** dans le `WriterNodeInput` construit :

```ts
browser_enabled: runConfig.enable_browser === true && browserToolDefs.length > 0,
```

### 3. Limite de navigation par nœud

Dans le `browserExecutor`, compter les appels `browser_navigate` / `browser_goto`
et rejeter (retourner `is_error: true`) au-delà de `max_nav_per_node`.

```ts
// Lire depuis orchestrator.yaml (via loadConfig ou une constante env)
const MAX_NAV = Number(process.env.PLAYWRIGHT_MCP_MAX_NAV ?? '10')
let navCount = 0
// Dans le map :
if ((call.name === 'browser_navigate' || call.name === 'browser_goto') && ++navCount > MAX_NAV) {
  return { id: call.id, content: `[blocked: max ${MAX_NAV} navigations per node]`, is_error: true }
}
```

---

## OpenAPI — `openapi/v1.yaml`

**Ajouter dans `CreateRunRequest` schema** (après `enable_web_search`) :

```yaml
enable_browser:
  type: boolean
  default: false
  description: >
    When `true`, WRITER nodes can use browser automation tools (browser_navigate,
    browser_snapshot, browser_click, browser_type, browser_close) via the
    Playwright MCP sidecar. Requires `playwright_mcp.enabled: true` in
    orchestrator.yaml and the sidecar running. Stored in `run_config.enable_browser`.
```

**Ajouter note** dans la description de `POST /runs` :
Mentionner que `enable_browser` requiert le profil Docker `playwright-mcp`.

---

## i18n

### `locales/en.json`

Dans la section `run_form` (après les clés `run_form.web_search.*`) :

```json
"run_form.browser.label": "Browser automation",
"run_form.browser.description": "Enables Playwright browser tools for navigating real web pages.",
"run_form.browser.auto_enabled": "✨ Auto-enabled — task requires browser interaction",
"run_form.browser.privacy_warn": "The browser can access URLs from the task description."
```

### `locales/fr.json`

```json
"run_form.browser.label": "Automatisation navigateur",
"run_form.browser.description": "Active les outils Playwright pour naviguer sur de vraies pages web.",
"run_form.browser.auto_enabled": "✨ Activé automatiquement — la tâche nécessite un navigateur",
"run_form.browser.privacy_warn": "Le navigateur peut accéder aux URLs de la description de tâche."
```

---

## Points critiques

- **`ToolDefinition` type** : vérifier le type exact dans `lib/llm/interface.ts`
  avant d'écrire les casts. L'interface `input_schema` peut être
  `{ type: 'object', properties: Record<string, unknown> }` ou `JsonSchema`.
- **`async-mutex` NOT installed** : ne PAS l'ajouter. Le semaphore 1-slot
  manuel ci-dessus (10 lignes) est suffisant et sans dépendance.
- **Dégradation gracieuse** : si `listToolsWithSchemas()` échoue (sidecar down),
  le nœud WRITER s'exécute sans outils browser — pas d'erreur fatale.
- **`@playwright/mcp` tool names** : les noms exacts des outils peuvent varier
  selon la version. Vérifier en lançant le sidecar :
  ```bash
  npx @playwright/mcp --port 9990 --headless &
  # puis dans Node.js :
  import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
  import { Client } from '@modelcontextprotocol/sdk/client/index.js'
  const t = new StreamableHTTPClientTransport(new URL('http://localhost:9990/mcp'))
  const c = new Client({ name: 'test', version: '1.0' })
  await c.connect(t); console.log(await c.listTools())
  ```
- **`combineExecutors`** : si web_search ET browser sont actifs simultanément,
  la solution la plus simple est deux `ToolInjectionLLMClient` imbriqués (web search
  en interne, browser en externe) — évite une fonction dispatcher.

---

## Tests

Fichier : `tests/agents/writer-browser-injection.test.ts`

Cas :
- Quand `enable_browser = true` ET sidecar répond : `browserToolDefs.length > 0`, `ToolInjectionLLMClient` créé avec browser tools
- Quand `enable_browser = true` ET sidecar down : writer s'exécute sans browser tools (dégradation gracieuse)
- Semaphore : deux appels concurrents → le second attend la release du premier
- `MAX_NAV` : 11e appel `browser_navigate` retourne `is_error: true`

---

## Critères d'acceptation

- [ ] `WriterNodeInput.browser_enabled?: boolean` ajouté dans `lib/agents/writer.ts`
- [ ] `buildSystemPrompt` inclut instruction browser quand `browser_enabled = true`
- [ ] `lib/agents/runner.ts` : semaphore 1-slot déclaré, acquis/releasé autour du bloc WRITER
- [ ] `lib/agents/runner.ts` : `listToolsWithSchemas()` appelé pour le skill `builtin-playwright-browser`
- [ ] `lib/agents/runner.ts` : `browserToolExecutor` route les calls MCP via `mcpSkillClient.callTool()`
- [ ] `lib/agents/runner.ts` : dégradation gracieuse si sidecar down
- [ ] Limite `MAX_NAV` enforced dans `browserExecutor`
- [ ] `openapi/v1.yaml` : `enable_browser` dans `CreateRunRequest`
- [ ] `locales/en.json` + `locales/fr.json` : clés `run_form.browser.*`
- [ ] `npx tsc --noEmit` passe sans erreur
- [ ] `npx jest --passWithNoTests --no-coverage` passe
