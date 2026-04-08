---
title: "TU-Phase3 — Runner injection: WRITER tool_use + tool_call_progress SSE"
spec: .specs/tasks/draft/llm-tool-use-web-search.feature.md#partie-4
depends_on: [tu-phase1-llm-core-tools, tu-phase2-tool-registry-web-search]
created: 2026-04-08
status: todo
round: 3
branch: feat/tu-phase3-runner-injection
---

## Objectif

Injecter les web search tools dans le nœud WRITER du runner.
Étendre `WriterOutput.execution_meta` pour exposer le `tool_calls_trace`.
Émettre un event SSE `tool_call_progress` visible dans le `NodeCard`.

---

## Prérequis

- `feat/tu-phase1-llm-core-tools` mergé : `ILLMClient` avec `tools?`, `ToolInjectionLLMClient`
- `feat/tu-phase2-tool-registry-web-search` mergé : `WEB_SEARCH_TOOL`, `makeWebSearchExecutor()`

---

## Spec de référence

- **Partie 4 §4.1 à §4.4** — `parseRunConfig()`, injection WRITER, `WriterOutput.execution_meta`
- **Partie 5 §5.3** — `tool_call_progress` SSE event
- **Partie 9** — backward compat

---

## Fichiers à modifier / créer

### 1. `lib/execution/run-config.ts`

**Étendre le type** (déjà créé partiellement dans MF-Phase1) :
```ts
export interface RunConfig {
  enable_web_search?:      boolean
  web_search_provider?:    'brave' | 'tavily' | 'duckduckgo'
  web_search_max_results?: number
  output_file_format?:     string   // vient du form (spec MF)
}
```

### 2. `types/events.ts`

Ajouter au discriminated union `RunSSEEvent` :
```ts
export type RunSSEEventToolCallProgress = {
  type:          'tool_call_progress'
  node_id:       string
  tool_name:     string       // 'web_search'
  iteration:     number       // 1-based
  query?:        string       // pour web_search: la query envoyée
  result_count?: number       // pour web_search: nb de résultats retournés
  is_error:      boolean
}
```

### 3. `lib/events/project-event-bus.interface.ts`

Ajouter `tool_call_progress` au `RunSSEEvent` interne :
```ts
| { type: 'tool_call_progress'; node_id: string; tool_name: string; iteration: number; query?: string; result_count?: number; is_error: boolean }
```

### 4. `lib/agents/writer.ts`

Dans `WriterOutput.execution_meta`, ajouter le champ optionnel :
```ts
tool_calls_trace?: import('@/lib/llm/interface').ToolCallIteration[]
```

Dans `Writer.execute()`, après avoir obtenu `result: ChatResult` (via `llm.chat()` ou `llm.stream()`), propager le trace :
```ts
execution_meta: {
  // ... champs existants ...
  ...(result.tool_calls_trace?.length ? { tool_calls_trace: result.tool_calls_trace } : {}),
}
```

### 5. `lib/agents/runner.ts`

Dans le `case 'WRITER'` du switch :

#### 5a — Construire tools/toolExecutor conditionnellement

```ts
const runConfig = parseRunConfig(runRow.run_config)
let tools:        ChatOptions['tools']        = undefined
let toolExecutor: ChatOptions['toolExecutor'] = undefined

if (runConfig.enable_web_search === true) {
  tools = [WEB_SEARCH_TOOL]
  toolExecutor = makeWebSearchExecutor(
    runConfig,
    db,
    { run_id: node.run_id, node_id: node.node_id ?? node.id },
    // emitSse callback — émet tool_call_progress
    (query: string, resultCount: number, iteration: number, isError: boolean) => {
      eventBus.emit({
        project_id,
        run_id: runId,
        event: {
          type:         'tool_call_progress',
          node_id:      node.node_id ?? node.id,
          tool_name:    'web_search',
          iteration,
          query,
          result_count: resultCount,
          is_error:     isError,
        },
        emitted_at: new Date(),
      }).catch(() => {})   // non-bloquant
    },
  )
}
```

#### 5b — Utiliser `ToolInjectionLLMClient` si tools définis

```ts
const writerLlm = (tools && toolExecutor)
  ? new ToolInjectionLLMClient(contextualLlm, tools, toolExecutor)
  : contextualLlm

const writer = new Writer(writerLlm)
const writerOutput = await writer.execute(writerNodeInput, signal, onChunk)
```

#### 5c — Persister `tool_calls_trace` dans `Node.metadata` (observabilité)

```ts
if (writerOutput.execution_meta?.tool_calls_trace?.length) {
  await db.node.update({
    where: { id: node.id },
    data:  {
      metadata: {
        ...(node.metadata as object ?? {}),
        tool_calls_trace: writerOutput.execution_meta.tool_calls_trace,
      },
    },
  })
}
```

#### 5d — Mettre à jour `makeWebSearchExecutor` signature

Adapter l'appel dans `tu-phase2` pour accepter le 4ème paramètre optionnel `emitSse` (voir spec §5.3).

### 6. Tests — `tests/agents/runner-web-search.test.ts` — NOUVEAU

```ts
// Mocker DirectLLMClient pour simuler un tool_call 'web_search'
// Vérifier :
// - writerOutput.execution_meta.tool_calls_trace contient 1 itération
// - SSE event tool_call_progress émis avec query + result_count
// - Si enable_web_search: false → aucun tool injecté, WriterOutput inchangé
// - tool_calls_trace stocké dans Node.metadata
```

---

## Règles de sécurité

- `toolExecutor` n'est JAMAIS appuyé sur des données venant directement du LLM sans validation — la validation est dans `makeWebSearchExecutor` (déjà faite en TU-Phase2)
- L'élection d'accès à SSE via `emitSse` callback est non-bloquante (`.catch(() => {})`)
- Si `enable_web_search` est absent ou false : comportement **identique à avant** (backward compat)

---

## Critères de validation

- [ ] Run avec `enable_web_search: true` → WRITER utilise `ToolInjectionLLMClient`
- [ ] Run avec `enable_web_search: false` (défaut) → WRITER utilise `contextualLlm` directement, aucun tool injecté
- [ ] `tool_call_progress` SSE émis après chaque appel web_search réussi
- [ ] `Node.metadata.tool_calls_trace` renseigné si tools utilisés
- [ ] `WriterOutput.execution_meta.tool_calls_trace` présent
- [ ] `npx tsc --noEmit` zéro erreur
- [ ] Tous les tests existants passent (backward compat)
- [ ] Nouveaux tests `runner-web-search.test.ts` verts

---

## Commit

```
feat(runner): inject web search tool into WRITER + tool_call_progress SSE

- lib/execution/run-config.ts: extend RunConfig with web_search_provider + max_results
- types/events.ts: RunSSEEventToolCallProgress
- lib/events/project-event-bus.interface.ts: tool_call_progress event
- lib/agents/writer.ts: tool_calls_trace in execution_meta
- lib/agents/runner.ts: ToolInjectionLLMClient injection in WRITER case,
  emitSse callback for tool_call_progress, Node.metadata trace storage
- tests/agents/runner-web-search.test.ts
```
