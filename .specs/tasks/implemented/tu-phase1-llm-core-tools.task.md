---
title: "TU-Phase1 — Core LLM layer: tool_use / function_calling"
spec: .specs/tasks/draft/llm-tool-use-web-search.feature.md
depends_on: []
created: 2026-04-08
status: todo
round: 1
branch: feat/tu-phase1-llm-core-tools
---

## Objectif

Étendre `ILLMClient` pour qu'il supporte les tools (function_calling / tool_use).
**Aucun agent ne change** — les boucles sont dans la couche LLM, transparentes pour WRITER/PLANNER.
**Backward compat garantie :** si `tools` absent → comportement identique à aujourd'hui.

---

## Spec de référence

Lire impérativement avant d'implémenter :
- **Partie 1** (`§1.1, §1.2, §1.3`) — types `ToolDefinition`, `ToolCall`, `ToolResult`, `ToolCallIteration`, extensions `ChatOptions`, `ChatResult`
- **Partie 2** (`§2.1 à §2.5`) — boucles agentiques Anthropic, OpenAI, Gemini + `stream()` avec tools
- **`§4.2`** — `ToolInjectionLLMClient` class

---

## Fichiers à modifier / créer

### 1. `lib/llm/interface.ts`

Ajouter à la suite de l'interface existante (ne pas supprimer l'existant) :

```ts
// ── Tool_use types (Partie 1 §1.1) ──────────────────────────────────────────

export interface ToolDefinition {
  name: string            // ^[a-z][a-z0-9_]{0,63}$
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, ToolParameterSchema>
    required?: string[]
  }
}

export interface ToolParameterSchema {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  enum?: (string | number)[]
  items?: ToolParameterSchema
  minimum?: number
  maximum?: number
}

export interface ToolCall {
  id:    string
  name:  string
  input: Record<string, unknown>
}

export interface ToolResult {
  tool_call_id: string
  content:      string
  is_error?:    boolean
}

export interface ToolCallIteration {
  iteration:    number
  tool_calls:   ToolCall[]
  tool_results: ToolResult[]
  tokens_in:    number
  tokens_out:   number
}
```

Étendre `ChatOptions` (voir §1.2) :
- Ajouter `tools?: ToolDefinition[]`
- Ajouter `toolExecutor?: (calls: ToolCall[], signal?: AbortSignal) => Promise<ToolResult[]>`
- Ajouter `maxToolIterations?: number`

Étendre `ChatResult` (voir §1.3) :
- Ajouter `tool_calls_trace?: ToolCallIteration[]`

### 2. `lib/llm/client.ts` — `DirectLLMClient`

Pour chaque provider, ajouter la boucle agentique. **Si `options.tools` est absent/vide, le comportement est inchangé.** Implémenter exactement la spec :

#### `callAnthropic` — voir spec §2.2
- Boucle `while(true)` avec `maxIter = Math.min(options.maxToolIterations ?? 5, 10)`
- Guard `CONTEXT_BUDGET` avant chaque itération (voir §2.2 — stopper si `totalIn > CONTEXT_BUDGET && iteration > 0`)
- JSON.parse déjà géré par le SDK Anthropic (pas de risque)
- `tool_calls_trace` accumulé par itération

#### `callOpenAI` (et compatible : cometapi, ollama, litellm, mistral, custom) — voir spec §2.3
- **Critique :** JSON.parse du `tc.function.arguments` dans un `try/catch` — retourner `{ __parse_error: raw }` au lieu de throw
- Extraire `runOpenAIToolLoop` comme helper réutilisable

#### `callGemini` — voir spec §2.4
- IDs uniques pour les function calls : `${nodeCtx?.node_id ?? 'gemini'}_${Date.now()}_${iteration}_${i}`
- Mapper `FunctionCall` SDK → `ToolCall` interface

### 3. `lib/llm/litellm-client.ts`

Utiliser le helper `runOpenAIToolLoop` extrait de `callOpenAI` (voir §2.3).

### 4. `lib/llm/mock-client.ts`

Ajouter :
```ts
private toolCallQueue: Array<ToolCall[]> = []

setNextToolCallResponse(calls: ToolCall[]): void {
  this.toolCallQueue.push(calls)
}
```

Dans `chat()` : si `options.toolExecutor` et `this.toolCallQueue.length > 0`, simuler une itération tool_use avec `this.toolCallQueue.shift()`.

### 5. `lib/llm/tool-injection-client.ts` — NOUVEAU (voir spec §4.2)

```ts
// lib/llm/tool-injection-client.ts
// ToolInjectionLLMClient — wraps any ILLMClient and pre-injects tools into every call.
// Unlike a plain { chat, stream } inline object, this class implements ILLMClient
// explicitly → TypeScript error immediately if the interface gains new methods.

import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from './interface'

export class ToolInjectionLLMClient implements ILLMClient {
  constructor(
    private readonly inner:        ILLMClient,
    private readonly tools:        import('./interface').ToolDefinition[],
    private readonly toolExecutor: NonNullable<ChatOptions['toolExecutor']>,
  ) {}

  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    return this.inner.chat(messages, { ...options, tools: this.tools, toolExecutor: this.toolExecutor })
  }

  stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult> {
    return this.inner.stream(
      messages,
      { ...options, tools: this.tools, toolExecutor: this.toolExecutor },
      onChunk,
      onModelResolved,
    )
  }
}
```

### 6. Tests — `tests/llm/tool-use-loop.test.ts` — NOUVEAU

Couvrir (voir spec §8, Partie 8) :
- Anthropic : réponse sans tools → pas de boucle
- Anthropic : 1 itération tool_call → résultat final
- OpenAI : `JSON.parse` malformé → `__parse_error` dans input, pas de throw
- Ollama : hard cap `maxToolIterations = 2` → arrêt propre
- `ToolInjectionLLMClient` : forwarde `tools` et `toolExecutor`
- Context budget guard : si `totalIn` simulé > budget → retour partiel

---

## Règles de sécurité

- Ne jamais throw depuis la boucle tool_use — capturer et retourner `content: '[error: ...]'`
- Le `toolExecutor` est fourni par le caller (runner.ts) — jamais instancié dans ce fichier
- Aucun appel réseau dans ce fichier (les tools seront dans TU-Phase2)

---

## Critères de validation

- [ ] `npx tsc --noEmit` passe avec zéro erreur après modifications
- [ ] `npx jest tests/llm/ --no-coverage` — tous les tests client existants passent
- [ ] Nouveaux tests `tool-use-loop.test.ts` verts
- [ ] `options.tools` absent → sortie identique à avant sur tous les providers
- [ ] `ToolInjectionLLMClient` compile sans cast `as any`

---

## Commit

```
feat(llm): add tool_use agentic loop to DirectLLMClient (Anthropic, OpenAI, Gemini)

- lib/llm/interface.ts: ToolDefinition, ToolCall, ToolResult, ToolCallIteration,
  tools/toolExecutor/maxToolIterations in ChatOptions, tool_calls_trace in ChatResult
- lib/llm/client.ts: agentic loop in callAnthropic (context window guard),
  callOpenAI (JSON.parse try/catch), callGemini (unique IDs);
  extract runOpenAIToolLoop helper
- lib/llm/litellm-client.ts: use runOpenAIToolLoop
- lib/llm/mock-client.ts: setNextToolCallResponse, toolCallQueue
- lib/llm/tool-injection-client.ts: ToolInjectionLLMClient implements ILLMClient
- tests/llm/tool-use-loop.test.ts: agentic loop unit tests
```
