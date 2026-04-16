---
title: "LLM tool_use — refactor orthogonal + web search opt-in"
depends_on: [multi-format-artifact-output]
created: 2026-04-08
status: draft
agents_completed: [architect-review]
agents_pending: [implementer]
---

# LLM tool_use — refactor orthogonal

## Périmètre

Ce document spécifie l'extension de la couche LLM (`lib/llm/`) pour supporter le **function_calling / tool_use** de manière native, provider-agnostique, et backward-compatible. Le cas d'usage primaire décrit est la **recherche web opt-in** pour les agents WRITER/PLANNER, mais l'infrastructure est générique — tout outil peut être branché via le même mécanisme.

**Ce que ce spec NE change pas :**
- `AgentRunnerFn` signature
- `AgentOutput` shape
- `IExecutionEngine` interface
- La structure des DAG / nœuds / handoffs
- Tous les agents existants (CLASSIFIER, PLANNER, REVIEWER, PYTHON_EXECUTOR…)
- Tests existants — zéro régression

**Ce que ce spec change :**
- `ILLMClient` : 2 nouveaux types + 1 champ optionnel dans `ChatOptions`
- `DirectLLMClient` : boucle agentique interne pour les 3 providers (Anthropic, OpenAI, Gemini)
- `LiteLLMClient` : même boucle (OpenAI-compatible)
- `MockLLMClient` : support des réponses tool_use en file
- `ContextualLLMClient` (`lib/agents/runner.ts`) : transparent — aucun changement
- `runner.ts` (`lib/agents/runner.ts`) : injection des outils dans `ChatOptions` avant d'appeler l'agent
- `lib/agents/tools/` : nouveau répertoire contenant définitions d'outils + executors
- `lib/agents/writer.ts` : **aucun changement** — tool_use est transparent
- `app/api/runs/route.ts` : nouveau champ `enable_web_search`
- `types/events.ts` : nouveau event `tool_call_progress`
- `openapi/v1.yaml` : nouveau champ + event

---

## Partie 1 — Extension de `ILLMClient`

### 1.1 Nouveaux types dans `lib/llm/interface.ts`

```typescript
// ─── Tool definition ──────────────────────────────────────────────────────────

/**
 * Schéma d'un outil exposé au LLM (function_calling / tool_use).
 * Compatible JSON Schema Draft-07.
 */
export interface ToolDefinition {
  /** Identifiant unique de l'outil. Noms valides: ^[a-z][a-z0-9_]{0,63}$ */
  name: string
  /** Description en langue naturelle — sera envoyée verbatim au LLM. */
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
  items?: ToolParameterSchema          // pour type: 'array'
  minimum?: number
  maximum?: number
}

/**
 * Appel d'outil demandé par le LLM dans une réponse.
 */
export interface ToolCall {
  /** Identifiant opaque généré par le provider (Anthropic: tool_use_id, OpenAI: tool_call.id). */
  id: string
  name: string
  /** Input parsé depuis le JSON renvoyé par le LLM — peut être un objet quelconque. */
  input: Record<string, unknown>
}

/**
 * Résultat d'exécution d'un tool_call, à renvoyer au LLM.
 */
export interface ToolResult {
  tool_call_id: string    // doit matcher ToolCall.id
  /** Contenu plain-text retourné au LLM. Tronqué à 16 384 chars si nécessaire. */
  content: string
  /** true si l'outil a échoué — le LLM doit le savoir pour adapter sa réponse. */
  is_error?: boolean
}

/**
 * Trace d'une itération de la boucle agentique (pour observabilité).
 */
export interface ToolCallIteration {
  iteration: number       // 1-based
  tool_calls: ToolCall[]
  tool_results: ToolResult[]
  tokens_in: number       // tokens consommés pour cette itération
  tokens_out: number
}
```

### 1.2 Extensions de `ChatOptions`

```typescript
export interface ChatOptions {
  model: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  selectionContext?: { /* inchangé */ }

  // ── Tool_use / function_calling (nouveaux champs optionnels) ──────────────

  /**
   * Liste d'outils disponibles pour le LLM dans cet appel.
   * Absent/vide = comportement actuel inchangé.
   */
  tools?: ToolDefinition[]

  /**
   * Callback appelé par DirectLLMClient à chaque fois que le LLM fait des
   * tool_calls. La valeur de retour est injectée dans le contexte de conversation
   * avant le prochain appel LLM.
   *
   * RESPONSABILITÉ DU CALLER :
   * - Valider les inputs avant exécution (never trust the LLM's JSON)
   * - Appliquer assertNotPrivateHost() sur tout URL
   * - Respecter signal pour annulation
   * - Retourner ToolResult[] de même longueur que ToolCall[] (ordre préservé)
   * - Ne jamais throw — erreurs encapsulées dans { is_error: true, content: msg }
   */
  toolExecutor?: (calls: ToolCall[], signal?: AbortSignal) => Promise<ToolResult[]>

  /**
   * Nombre maximum d'itérations de la boucle tool_use.
   * Défaut : 5. Maximum absolu appliqué par DirectLLMClient : 10.
   * Prévient les boucles infinies.
   */
  maxToolIterations?: number
}
```

### 1.3 Extensions de `ChatResult`

```typescript
export interface ChatResult {
  content: string
  tokensIn: number
  tokensOut: number
  model: string
  costUsd: number

  /**
   * Trace des itérations outil, uniquement présent si ≥1 tool_call a eu lieu.
   * Absent = aucun outil utilisé (comportement actuel préservé).
   */
  tool_calls_trace?: ToolCallIteration[]
}
```

---

## Partie 2 — Boucle agentique dans `DirectLLMClient`

### 2.1 Principe de la boucle

```
messages_init = messages
iteration = 0
loop:
  response = provider.call(messages_current, tools)
  if response has NO tool_calls:
    return ChatResult{ content: response.text, ... }
  if iteration >= maxToolIterations (default 5, hard cap 10):
    return ChatResult{ content: "(tool limit reached)", ... }  // ne jamais throw
  tool_results = toolExecutor(response.tool_calls, signal)
  messages_current = messages_current
    + [assistant_msg_with_tool_calls]
    + [tool_result_messages]
  iteration++
```

Les tokens de chaque itération s'accumulent dans `tokensIn` / `tokensOut` totaux.

### 2.2 `callAnthropic` — extension tool_use

**Fichier:** `lib/llm/client.ts`

```typescript
// Nouveau type interne
type AnthropicToolCall = { type: 'tool_use'; id: string; name: string; input: unknown }
type AnthropicTextBlock = { type: 'text'; text: string }
type AnthropicContentBlock = AnthropicToolCall | AnthropicTextBlock

// Extension de callAnthropic (remplacement complet de la fonction)
async function callAnthropic(
  profile: LlmProfileConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  const client = buildAnthropicClient(profile)
  const anthropicMessages = toAnthropicMessages(messages)
  const tools = options.tools?.length ? options.tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.input_schema,
  })) : undefined

  let currentMessages = [...anthropicMessages]
  let totalIn = 0
  let totalOut = 0
  const trace: ToolCallIteration[] = []
  const maxIter = Math.min(options.maxToolIterations ?? 5, 10)
  // Context window guard: estimer les tokens restants avant chaque itération.
  // Anthropic: max context varie par modèle (claude-3-5 = 200k, haiku = 200k, claude-3 opus = 200k).
  // On utilise une heuristique prudente : arrêt si totalIn > 80% de 8192 (budget conservateur pour modèles à context limité).
  const CONTEXT_BUDGET = options.maxTokens ? options.maxTokens * 10 : 80_000
  let iteration = 0

  while (true) {
    // Vérifier le budget de context avant chaque appel
    if (totalIn > CONTEXT_BUDGET && iteration > 0) {
      return {
        content: trace.length > 0
          ? '[context budget reached — partial result from previous iterations]'
          : '[context budget reached]',
        tokensIn: totalIn, tokensOut: totalOut,
        model: profile.model_string,
        costUsd: 0,
        tool_calls_trace: trace.length > 0 ? trace : undefined,
      }
    }
    const resp = await client.messages.create({
      model:       profile.model_string,
      max_tokens:  options.maxTokens ?? 4096,
      system:      currentMessages.find(m => m.role === 'system')?.content,
      messages:    currentMessages.filter(m => m.role !== 'system'),
      ...(tools ? { tools, tool_choice: { type: 'auto' } } : {}),
    })

    totalIn  += resp.usage.input_tokens
    totalOut += resp.usage.output_tokens

    const toolUseBlocks = resp.content.filter((b): b is AnthropicToolCall => b.type === 'tool_use')
    const textContent = resp.content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map(b => b.text).join('')

    if (toolUseBlocks.length === 0 || !options.toolExecutor) {
      // Réponse finale — pas de tool_calls
      return {
        content: textContent,
        tokensIn: totalIn, tokensOut: totalOut,
        model: profile.model_string,
        costUsd: 0,   // computeCostUsd appliqué par l'appelant
        ...(trace.length > 0 ? { tool_calls_trace: trace } : {}),
      }
    }

    if (iteration >= maxIter) {
      // Hard cap — on retourne ce qu'on a (texte partiel ou vide)
      return {
        content: textContent || '[tool iteration limit reached]',
        tokensIn: totalIn, tokensOut: totalOut,
        model: profile.model_string,
        costUsd: 0,
        tool_calls_trace: trace,
      }
    }

    // Exécuter les tool_calls
    const calls: ToolCall[] = toolUseBlocks.map(b => ({
      id: b.id, name: b.name, input: b.input as Record<string, unknown>,
    }))
    const results = await options.toolExecutor(calls, options.signal)

    trace.push({
      iteration: iteration + 1,
      tool_calls: calls,
      tool_results: results,
      tokens_in: resp.usage.input_tokens,
      tokens_out: resp.usage.output_tokens,
    })

    // Construire les messages pour la prochaine itération
    // Anthropic: assistant turn = content blocks (text + tool_use)
    //            user turn    = tool_result content blocks
    currentMessages = [
      ...currentMessages,
      {
        role: 'assistant',
        content: resp.content as unknown,   // conserve les blocs structurés
      },
      {
        role: 'user',
        content: results.map(r => ({
          type:        'tool_result',
          tool_use_id:  r.tool_call_id,
          content:      r.content,
          ...(r.is_error ? { is_error: true } : {}),
        })),
      },
    ] as unknown as typeof currentMessages   // cast nécessaire pour Anthropic SDK types

    iteration++
  }
}
```

**Note sur `toAnthropicMessages`:** nouvelle fonction qui convertit `ChatMessage[]` en `Anthropic.MessageParam[]`. Les messages `system` sont extraits séparément (param top-level). Cette fonction existe déjà implicitement dans le code actuel — elle est formalisée ici.

### 2.3 `callOpenAI` — extension function_calling

**Concerne:** openai, cometapi, ollama, litellm, mistral, custom (tous les providers OpenAI-compatible)

```typescript
async function callOpenAI(
  profile: LlmProfileConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  const client = await buildOpenAIClient(profile)
  const oaiMessages = toOpenAIMessages(messages)
  const tools = options.tools?.length ? options.tools.map(t => ({
    type: 'function' as const,
    function: {
      name:        t.name,
      description: t.description,
      parameters:  t.input_schema,
    },
  })) : undefined

  let currentMessages = [...oaiMessages]
  let totalIn = 0
  let totalOut = 0
  const trace: ToolCallIteration[] = []
  const maxIter = Math.min(options.maxToolIterations ?? 5, 10)
  let iteration = 0

  while (true) {
    const resp = await client.chat.completions.create({
      model:      profile.model_string,
      max_tokens: options.maxTokens ?? 4096,
      messages:   currentMessages,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    })

    const msg = resp.choices[0].message
    totalIn  += resp.usage?.prompt_tokens    ?? 0
    totalOut += resp.usage?.completion_tokens ?? 0

    if (!msg.tool_calls?.length || !options.toolExecutor) {
      return {
        content: msg.content ?? '',
        tokensIn: totalIn, tokensOut: totalOut,
        model: resp.model ?? profile.model_string,
        costUsd: 0,
        ...(trace.length > 0 ? { tool_calls_trace: trace } : {}),
      }
    }

    if (iteration >= maxIter) {
      return {
        content: msg.content ?? '[tool iteration limit reached]',
        tokensIn: totalIn, tokensOut: totalOut,
        model: resp.model ?? profile.model_string,
        costUsd: 0,
        tool_calls_trace: trace,
      }
    }

    const calls: ToolCall[] = msg.tool_calls.map(tc => {
      let parsedInput: Record<string, unknown> = {}
      try {
        parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>
      } catch {
        // Modèle open-source: arguments JSON malformé — ne pas throw, retourner is_error
        return {
          id:    tc.id,
          name:  tc.function.name,
          input: { __parse_error: tc.function.arguments },
        }
      }
      return { id: tc.id, name: tc.function.name, input: parsedInput }
    })
    const results = await options.toolExecutor(calls, options.signal)

    trace.push({
      iteration: iteration + 1,
      tool_calls: calls,
      tool_results: results,
      tokens_in:  resp.usage?.prompt_tokens    ?? 0,
      tokens_out: resp.usage?.completion_tokens ?? 0,
    })

    currentMessages = [
      ...currentMessages,
      {
        role:       'assistant',
        content:    msg.content ?? null,
        tool_calls: msg.tool_calls,
      },
      ...results.map(r => ({
        role:         'tool' as const,
        tool_call_id: r.tool_call_id,
        content:      r.content,
      })),
    ]

    iteration++
  }
}
```

**Cas Ollama / LM Studio :** ces providers ne supportent pas tous les modèles avec tool_calling. Si le modèle ne supporte pas les tools, le provider renvoie une erreur ou ignore le champ `tools`. La boucle reste correcte — `msg.tool_calls` sera absent → sortie immédiate.

### 2.4 `callGemini` — extension function declarations

```typescript
async function callGemini(
  profile: LlmProfileConfig,
  messages: ChatMessage[],
  options: ChatOptions,
): Promise<ChatResult> {
  const genAI = new GoogleGenerativeAI(apiKey)
  
  const functionDeclarations = options.tools?.length
    ? options.tools.map(t => ({
        name:        t.name,
        description: t.description,
        parameters:  t.input_schema,
      }))
    : undefined

  const model = genAI.getGenerativeModel({
    model: profile.model_string,
    ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
  })

  let contents = toGeminiContents(messages)   // fonction existante
  let totalIn = 0
  let totalOut = 0
  const trace: ToolCallIteration[] = []
  const maxIter = Math.min(options.maxToolIterations ?? 5, 10)
  let iteration = 0

  while (true) {
    const resp = await model.generateContent({ contents })

    totalIn  += resp.response.usageMetadata?.promptTokenCount ?? 0
    totalOut += resp.response.usageMetadata?.candidatesTokenCount ?? 0

    const parts = resp.response.candidates?.[0]?.content?.parts ?? []
    const funcCalls = parts.filter(p => p.functionCall)
    const textContent = parts.filter(p => p.text).map(p => p.text).join('')

    if (funcCalls.length === 0 || !options.toolExecutor) {
      return {
        content: textContent,
        tokensIn: totalIn, tokensOut: totalOut,
        model: profile.model_string,
        costUsd: 0,
        ...(trace.length > 0 ? { tool_calls_trace: trace } : {}),
      }
    }

    if (iteration >= maxIter) {
      return {
        content: textContent || '[tool iteration limit reached]',
        tokensIn: totalIn, tokensOut: totalOut,
        model: profile.model_string,
        costUsd: 0,
        tool_calls_trace: trace,
      }
    }

    const calls: ToolCall[] = funcCalls.map((p, i) => ({
      // Gemini n'expose pas d'ID per-functionCall — générer un ID stable unique au run
      id:    `${nodeCtx?.node_id ?? 'g'}_${Date.now()}_${iteration}_${i}`,
      name:  p.functionCall!.name,
      input: p.functionCall!.args as Record<string, unknown>,
    }))
    const results = await options.toolExecutor(calls, options.signal)

    trace.push({
      iteration: iteration + 1,
      tool_calls: calls,
      tool_results: results,
      tokens_in:  resp.response.usageMetadata?.promptTokenCount ?? 0,
      tokens_out: resp.response.usageMetadata?.candidatesTokenCount ?? 0,
    })

    // Gemini: ajouter le tour model (functionCall) + user (functionResponse)
    contents = [
      ...contents,
      {
        role: 'model',
        parts: funcCalls.map(p => ({ functionCall: p.functionCall })),
      },
      {
        role: 'user',
        parts: results.map((r, i) => ({
          functionResponse: {
            name:     calls[i].name,
            response: { content: r.content, is_error: r.is_error ?? false },
          },
        })),
      },
    ]

    iteration++
  }
}
```

### 2.5 `stream()` avec tools — stratégie "loop then stream"

Quand `options.tools?.length > 0` :

```typescript
async stream(messages, options, onChunk, onModelResolved?): Promise<ChatResult> {
  if (options.tools?.length) {
    // Phase 1: boucle tool_use non-streaming (comme chat())
    // L'UI doit afficher un spinner pendant ce silence (voir UX spec §5.3)
    const result = await this.chat(messages, options)
    // Phase 2: simuler le streaming sur le résultat final
    if (result.content) {
      onChunk(result.content)    // un seul chunk
    }
    onModelResolved?.(result.model)
    return result
  }
  // Comportement actuel inchangé quand pas de tools
  return this.dispatchStream(profile, messages, options, onChunk)
}
```

**Justification:** Streamer pendant la boucle tool_use complexifie massivement la gestion des tokens provider-side. La latence visible est dominée par les appels HTTP de recherche web, pas par la génération de tokens.

**Gap UX — obligation de spec :** Quand `tools` est actif, le WRITER stream en silence pendant la boucle. L'UI **doit** afficher un état de chargement explicite entre le début du node WRITER et l'arrivée du premier chunk :

```ts
// run-detail-client.tsx — NodeCard : détecter le silence après RUNNING
// Si partial_output est vide 3s après que le node passe RUNNING
// et que le run_config.enable_web_search === true :
// afficher "\uD83C\uDF10 Recherche web en cours\u2026" dans partial_output placeholder
```

L'état est effacé dès que le premier `node_snapshot` SSE arrive avec un `partial_output` non vide.

### 2.6 `LiteLLMClient` — extension

`LiteLLMClient` est déjà OpenAI-compatible. Seule modification : passer le champ `tools` au `client.chat.completions.create()` call, et implémenter la même boucle que `callOpenAI`. La surcharge est minimale car la logique est partagée via `callOpenAI` (si refactorisé en fonction séparée) ou dupliquée dans `LiteLLMClient`. Recommandation : extraire la boucle en `runOpenAIToolLoop(client, model, messages, tools, toolExecutor, maxIter)` — utilisée par `callOpenAI` ET `LiteLLMClient`.

### 2.7 `MockLLMClient` — extension

```typescript
export class MockLLMClient implements ILLMClient {
  // Existant : responseQueue, calls, delayMs, setNextResponse, setResponses, reset

  // ── Nouveau : support tool_call responses ────────────────────────────────

  /**
   * File de réponses contenant des tool_calls.
   * Chaque entrée représente UNE itération de la boucle.
   * Format : { tool_calls: ToolCall[], finalContent?: string }
   * S'il y a des tool_calls, le mock appelle toolExecutor puis ajoute une
   * réponse text (finalContent ou prochaine réponse de responseQueue).
   */
  private toolCallQueue: Array<{
    tool_calls: ToolCall[]
    finalContent?: string    // si présent, réponse finale après l'exécution des tools
  }> = []

  setNextToolCallResponse(
    tool_calls: ToolCall[],
    finalContent?: string,
  ): this {
    this.toolCallQueue.push({ tool_calls, finalContent })
    return this
  }

  async chat(messages, options): Promise<ChatResult> {
    this.calls.push({ messages, options })
    await new Promise(r => setTimeout(r, this.delayMs))

    // Si il y a un tool_call en file AND toolExecutor présent
    if (this.toolCallQueue.length > 0 && options.toolExecutor) {
      const entry = this.toolCallQueue.shift()!
      const results = await options.toolExecutor(entry.tool_calls, options.signal)
      const finnalContent = entry.finalContent ?? (this.responseQueue.shift() ?? '')
      return {
        content: finnalContent,
        tokensIn: 50, tokensOut: 50,
        model: 'mock',
        costUsd: 0,
        tool_calls_trace: [{
          iteration: 1,
          tool_calls: entry.tool_calls,
          tool_results: results,
          tokens_in: 25, tokens_out: 25,
        }],
      }
    }

    const content = this.responseQueue.shift() ?? ''
    return { content, tokensIn: 10, tokensOut: 10, model: 'mock', costUsd: 0 }
  }

  async stream(messages, options, onChunk, onModelResolved?): Promise<ChatResult> {
    const result = await this.chat(messages, options)
    onModelResolved?.('mock')
    onChunk(result.content)
    return result
  }
}
```

---

## Partie 3 — Tool Registry et Web Search Executor

### 3.1 Structure du répertoire

```
lib/agents/tools/
  registry.ts         — ToolDefinition[] des outils disponibles
  web-search.ts       — WebSearchExecutor (implém. des providers)
  index.ts            — exports
```

### 3.2 `lib/agents/tools/registry.ts`

```typescript
import type { ToolDefinition } from '@/lib/llm/interface'

export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for current, real-time information. ' +
    'Use this when you need facts published after your training cutoff, ' +
    'current pricing, recent news, or up-to-date documentation. ' +
    'Returns titles, URLs, and text snippets from search results.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Be specific. Max 120 characters.',
      },
      max_results: {
        type: 'integer',
        description: 'Number of results to return. Default: 5. Max: 10.',
        minimum: 1,
        maximum: 10,
      },
    },
    required: ['query'],
  },
}

// Future tools:
//   FETCH_URL_TOOL   — fetch specific URL content (Phase 2)
//   CODE_EXEC_TOOL   — lightweight Python eval (Phase 3)
```

### 3.3 `lib/agents/tools/web-search.ts`

```typescript
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import type { ToolCall, ToolResult } from '@/lib/llm/interface'
import type { RunConfig } from '@/lib/execution/run-config'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WebSearchResultItem {
  title:      string
  url:        string
  snippet:    string
  published?: string   // ISO date if provided by the API
}

export interface WebSearchResponse {
  query:       string
  results:     WebSearchResultItem[]
  provider:    string
  searched_at: string   // ISO datetime
  error?:      string   // présent si dégradation gracieuse
}

// ─── Provider implementations ────────────────────────────────────────────────

// Brave Search API
async function searchBrave(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY not set')

  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(maxResults, 10)))
  url.searchParams.set('result_filter', 'web')

  // SSRF guard — domain est public mais on vérifie quand même
  await assertNotPrivateHost(url.toString())

  const resp = await fetch(url.toString(), {
    headers: {
      'Accept':            'application/json',
      'Accept-Encoding':   'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal,
  })

  if (!resp.ok) throw new Error(`Brave API ${resp.status}: ${resp.statusText}`)

  const data = await resp.json() as {
    web?: { results?: Array<{ title: string; url: string; description?: string; age?: string }> }
  }

  return (data.web?.results ?? []).map(r => ({
    title:     r.title,
    url:       r.url,
    snippet:   r.description ?? '',
    published: r.age,
  }))
}

// Tavily Search API
async function searchTavily(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) throw new Error('TAVILY_API_KEY not set')

  await assertNotPrivateHost('https://api.tavily.com/search')

  const resp = await fetch('https://api.tavily.com/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      api_key:        apiKey,
      query,
      max_results:    Math.min(maxResults, 10),
      search_depth:   'basic',
      include_answer: false,
    }),
    signal,
  })

  if (!resp.ok) throw new Error(`Tavily API ${resp.status}: ${resp.statusText}`)

  const data = await resp.json() as {
    results?: Array<{ title: string; url: string; content?: string; published_date?: string }>
  }

  return (data.results ?? []).map(r => ({
    title:     r.title,
    url:       r.url,
    snippet:   r.content ?? '',
    published: r.published_date,
  }))
}

// DuckDuckGo (no API key — HTML scraping via Lite endpoint)
async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  // Utilise le endpoint HTML de DDG Lite — pas de JS requis
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  await assertNotPrivateHost(url)

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-assistant/1.0)' },
    signal,
  })

  if (!resp.ok) throw new Error(`DDG ${resp.status}`)

  // Parsing HTML minimal — extraire les liens et snippets de la page Lite
  const html = await resp.text()
  const results: WebSearchResultItem[] = []

  // DDG Lite structure: liens dans <a class="result-link">, snippets dans <td class="result-snippet">
  // Regex conservatrice — pas de dépendance HTML parser
  const linkRe   = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
  const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([^<]+)</g

  let linkMatch: RegExpExecArray | null
  let snippetMatch: RegExpExecArray | null
  const links: { url: string; title: string }[] = []
  const snippets: string[] = []

  while ((linkMatch = linkRe.exec(html)) !== null) {
    links.push({ url: decodeURIComponent(linkMatch[1]), title: linkMatch[2].trim() })
  }
  while ((snippetMatch = snippetRe.exec(html)) !== null) {
    snippets.push(snippetMatch[1].trim())
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? '' })
  }

  return results
}

// ─── Main executor factory ────────────────────────────────────────────────────

/**
 * Crée le toolExecutor à passer dans ChatOptions.toolExecutor.
 * Compatible avec la signature (calls: ToolCall[], signal?: AbortSignal) => Promise<ToolResult[]>.
 */
export function makeWebSearchExecutor(
  runConfig: RunConfig,
  db: { sourceTrustEvent: { createMany: (args: unknown) => Promise<unknown> } },
  nodeCtx: { run_id: string; node_id: string },
): (calls: ToolCall[], signal?: AbortSignal) => Promise<ToolResult[]> {
  return async (calls, signal) => {
    return Promise.all(
      calls.map(async (call): Promise<ToolResult> => {
        if (call.name !== 'web_search') {
          return { tool_call_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true }
        }

        const query      = String(call.input.query ?? '').slice(0, 120)
        const maxResults = Math.min(Number(call.input.max_results ?? 5), 10)
        const provider   = runConfig.web_search_provider ?? 'brave'

        if (!query) {
          return { tool_call_id: call.id, content: 'Empty query.', is_error: true }
        }

        try {
          let items: WebSearchResultItem[]

          // Retry une fois sur erreur réseau
          try {
            items = await searchByProvider(provider, query, maxResults, signal)
          } catch {
            await new Promise(r => setTimeout(r, 1000))   // backoff 1s
            items = await searchByProvider(provider, query, maxResults, signal)
          }

          // SSRF guard sur chaque URL dans les résultats
          const safeItems = await Promise.all(
            items.map(async item => {
              try {
                await assertNotPrivateHost(item.url)
                return item
              } catch {
                return null   // filtre silencieux
              }
            })
          ).then(arr => arr.filter((i): i is WebSearchResultItem => i !== null))

          // Log dans SourceTrustEvent (modèle DB existant)
          if (safeItems.length > 0) {
            await db.sourceTrustEvent.createMany({
              data: safeItems.map(r => ({
                run_id:       nodeCtx.run_id,
                node_id:      nodeCtx.node_id,
                source_type:  'web_search',
                source_url:   r.url,
                trust_score:  null,
                created_at:   new Date(),
              })),
            })
          }

          // Format retourné au LLM — compact, plain text
          const formatted = safeItems.length
            ? safeItems.map((r, i) =>
                `[${i + 1}] ${r.title}\n${r.url}${r.published ? ` (${r.published})` : ''}\n${r.snippet}`
              ).join('\n\n')
            : 'No results found.'

          return {
            tool_call_id: call.id,
            content: `Search: "${query}"\nProvider: ${provider}\nSearched at: ${new Date().toISOString()}\n\n${formatted}`,
          }

        } catch (err) {
          // Dégradation gracieuse — jamais throw vers le LLM loop
          const msg = err instanceof Error ? err.message : String(err)
          return {
            tool_call_id: call.id,
            content: `Web search temporarily unavailable (${provider}): ${msg}. Continue without real-time data.`,
            is_error: true,
          }
        }
      })
    )
  }
}

async function searchByProvider(
  provider: string,
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  switch (provider) {
    case 'brave':      return searchBrave(query, maxResults, signal)
    case 'tavily':     return searchTavily(query, maxResults, signal)
    case 'duckduckgo': return searchDuckDuckGo(query, maxResults, signal)
    default:           throw new Error(`Unknown web search provider: ${provider}`)
  }
}
```

---

## Partie 4 — Injection dans `lib/agents/runner.ts`

### 4.1 Typed `RunConfig`

**Nouveau fichier** `lib/execution/run-config.ts` :

```typescript
export interface RunConfig {
  /** Active la recherche web via tool_use pour les nœuds éligibles. Défaut: false. */
  enable_web_search?: boolean
  /** Provider de recherche web. Défaut: 'brave'. */
  web_search_provider?: 'brave' | 'tavily' | 'duckduckgo'
  /** Nombre max de résultats par requête. Défaut: 5. Max: 10. */
  web_search_max_results?: number
}

export function parseRunConfig(raw: unknown): RunConfig {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  return {
    enable_web_search:      r.enable_web_search === true,
    web_search_provider:    ['brave','tavily','duckduckgo'].includes(r.web_search_provider as string)
                              ? r.web_search_provider as RunConfig['web_search_provider']
                              : undefined,
    web_search_max_results: typeof r.web_search_max_results === 'number'
                              ? Math.min(Math.max(1, r.web_search_max_results), 10)
                              : undefined,
  }
}
```

### 4.2 Injection dans le cas `WRITER` de `lib/agents/runner.ts`

**Fichier:** `lib/agents/runner.ts`

```typescript
// lib/agents/runner.ts — dans le switch, cas WRITER
case 'WRITER': {
  // ... code existant : build WriterNodeInput ...

  // ── Inject web search tool if enabled ────────────────────────────────────
  const runConfig = parseRunConfig(runRow.run_config)
  const writerNodeMeta = node.metadata as Record<string, unknown>

  let tools: ToolDefinition[] | undefined
  let toolExecutor: ChatOptions['toolExecutor'] | undefined

  if (
    runConfig.enable_web_search === true &&
    writerNodeMeta.web_search_enabled !== false   // nœud peut opt-out via metadata
  ) {
    tools        = [WEB_SEARCH_TOOL]
    toolExecutor = makeWebSearchExecutor(runConfig, db, {
      run_id:  node.run_id,
      node_id: node.node_id ?? node.id,
    })
  }

  // ContextualLLMClient already wraps captureClient — tools are forwarded via ChatOptions
  //
  // ToolInjectionLLMClient instead of inline object literal:
  // prevents TypeScript silence when ILLMClient gains new methods,
  // and makes the delegation explicit.
  const writerLlm = new ToolInjectionLLMClient(contextualLlm, tools, toolExecutor)

  const writer = new Writer(writerLlm)
  const writerOutput = await writer.execute(writerNodeInput, signal, onChunk)

  // ... code existant : handleArtifactConversion, return AgentOutput ...

  // ── Emit tool_call_progress SSE if tools were used ───────────────────────
  // (accès au trace via writerOutput.execution_meta — voir §4.3)
  break
}
```

**Note critique :** `Writer.execute()` appelle `llm.chat()` ou `llm.stream()`. Ces méthodes reçoivent maintenant `tools` et `toolExecutor` dans les options injectées. La classe `Writer` ne voit jamais le mot "tool" — c'est transparent. Le LLM inside the writer will use the tool whenever it judges it necessary, based on the tool description.

**`ToolInjectionLLMClient` — nouveau fichier `lib/llm/tool-injection-client.ts` :**

```typescript
import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from './interface'

/**
 * Wrapper qui injecte des tools dans ChatOptions avant de déléguer au client wrappé.
 * Implémente ILLMClient explicitement pour détecter les breakages d'interface au compile.
 */
export class ToolInjectionLLMClient implements ILLMClient {
  constructor(
    private readonly inner: ILLMClient,
    private readonly tools:        ChatOptions['tools'],
    private readonly toolExecutor: ChatOptions['toolExecutor'],
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

### 4.3 Propagation du `tool_calls_trace`

Le `ContextualLLMClient` accumule déjà `totalCostUsd / totalTokensIn / tokensOut` via les `ChatResult` retournés. Les tokens issus des itérations tool_use s'accumulent dans les totaux — toute la boucle est comptabilisée dans le coût du nœud. Aucun changement nécessaire à `ContextualLLMClient`.

Pour l'observabilité, stocker le `tool_calls_trace` dans `Node.metadata.tool_calls_trace` :

```typescript
// lib/agents/runner.ts — après que writer.execute() retourne, avant le return AgentOutput
if (chatResult && chatResult.tool_calls_trace?.length) {
  node.metadata = {
    ...(node.metadata as object | null ?? {}),
    tool_calls_trace: chatResult.tool_calls_trace,
  }
  // sera écrit dans DB via executor.ts: node.update({ metadata })
}
```

Problème : `Writer.execute()` retourne `WriterOutput`, pas `ChatResult`. Pour exposer le trace, deux options :
- **Option A (recommandée) :** étendre `WriterOutput.execution_meta` avec `tool_calls_trace?: ToolCallIteration[]` — l'executor le lit après l'appel et l'injecte dans `Node.metadata`
- **Option B :** passer un callback `onToolCallIteration` dans `Writer.execute()` — plus invasif

→ **Choisir Option A** : ajouter `tool_calls_trace?: ToolCallIteration[]` à `WriterOutput.execution_meta`. Le Writer le renseigne depuis le `ChatResult.tool_calls_trace`.

### 4.4 Modification de `Writer.execute()`

Seule addition dans `Writer.execute()` :

```typescript
// Après avoir obtenu result = await this.llm.chat(...) OU stream(...)
// (result est de type ChatResult)

return {
  // ... payload WriterOutput existant ...
  execution_meta: {
    llm_used:          result.model,
    tokens_input:      result.tokensIn,
    tokens_output:     result.tokensOut,
    duration_seconds:  (Date.now() - startTime) / 1000,
    retries:           retryCount,
    // Addition:
    ...(result.tool_calls_trace?.length
      ? { tool_calls_trace: result.tool_calls_trace }
      : {}),
  },
}
```

Aucun autre changement dans `Writer`.

---

## Partie 5 — API et UI

### 5.1 `POST /api/runs` — ajout `enable_web_search`

```typescript
// app/api/runs/route.ts
const CreateRunBody = z.object({
  // ... champs existants ...
  enable_web_search: z.boolean().optional().default(false),    // NEW
}).strict()

// Dans le handler — valider que le provider est configuré si web_search activé
if (parsed.data.enable_web_search) {
  const hasBrave   = !!process.env.BRAVE_SEARCH_API_KEY
  const hasTavily  = !!process.env.TAVILY_API_KEY
  const hasDDG     = true   // pas de clé requise
  if (!hasBrave && !hasTavily && !hasDDG) {
    return NextResponse.json(
      { error: 'Web search enabled but no provider is configured. Set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY.' },
      { status: 400 },
    )
  }
}

// Construction de run_config :
const run_config: RunConfig = {
  ...(parsed.data.enable_web_search ? { enable_web_search: true } : {}),
}
```

**Note :** DuckDuckGo est toujours disponible (pas de clé), donc la validation retourne `400` uniquement si aucun provider n'est configuré DU TOUT — ce cas est impossible en pratique avec DDG. La validation sert surtout de garde-fou explétion lors de la migration.

### 5.2 Formulaire new run — toggle web search

**Fichier :** `app/(app)/projects/[projectId]/runs/new/page.tsx`

Le toggle est dans `<Collapsible>` "Options avancées" (déjà prévu pour budget_tokens):

```tsx
<FormField
  control={form.control}
  name="enable_web_search"
  render={({ field }) => (
    <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
      <FormControl>
        <Checkbox checked={field.value} onCheckedChange={field.onChange} />
      </FormControl>
      <div className="space-y-1 leading-none">
        <FormLabel>{t('run.web_search.label')}</FormLabel>
        <FormDescription>{t('run.web_search.description')}</FormDescription>
      </div>
    </FormItem>
  )}
/>
```

**Clés i18n :**

```json
// locales/fr.json
"run.web_search.label": "🌐 Recherche web en temps réel",
"run.web_search.description": "Permet aux agents de rechercher des informations actuelles sur internet. Peut augmenter la durée et le coût du run.",
"run.web_search.data_warning": "⚠️ Les requêtes de recherche peuvent exposer des termes de votre prompt à l'API de recherche (Brave/Tavily). À éviter si votre demande contient des informations confidentielles.",

// locales/en.json
"run.web_search.label": "🌐 Real-time web search",
"run.web_search.description": "Allows agents to search for current information on the web. May increase run duration and cost.",
"run.web_search.data_warning": "⚠️ Search queries may expose terms from your prompt to the search API (Brave/Tavily). Avoid if your request contains sensitive information."
```

Le `data_warning` est affiché en dessous de la checkbox quand elle est cochée. Masqué si DuckDuckGo est le seul provider (pas de transmission de données tiers).

### 5.3 Nouveau SSE event `tool_call_progress`

```typescript
// types/events.ts — addition à RunSSEEvent
| {
    type:         'tool_call_progress'
    node_id:      string
    tool_name:    string       // 'web_search'
    iteration:    number       // 1-based
    query?:       string       // pour web_search: la query envoyée
    result_count?: number      // pour web_search: nb de résultats
    is_error:     boolean
  }
```

**Emission :** dans `makeWebSearchExecutor()`, après avoir obtenu les résultats, émettre via le bus SSE. Pour accéder au bus depuis le executor, le passer en paramètre optionnel :

```typescript
export function makeWebSearchExecutor(
  runConfig: RunConfig,
  db: { sourceTrustEvent: { createMany: (args: unknown) => Promise<unknown> } },
  nodeCtx: { run_id: string; node_id: string },
  emitSse?: (event: unknown) => void,   // optionnel — absent dans les tests
): (calls: ToolCall[], signal?: AbortSignal) => Promise<ToolResult[]>
```

Dans `lib/agents/runner.ts`, lors de la construction de `makeWebSearchExecutor(...)`, passer `emitSse = (event) => this._emit(runId, event)` (accès via closure sur l'executor).

**UI — NodeCard pour nœuds WRITER avec web_search:**

```
📝 Analyse des ventes Q1
   🌐 Recherche web · "current Q1 market data 2026" · 5 résultats
   ✍️ Rédaction en cours...
```

(Rendu dans `run-detail-client.tsx`, `NodeCard`, section partial_output / SSE events)

---

## Partie 6 — Configuration admin

### 6.1 Variables d'environnement (priorité 1)

```
BRAVE_SEARCH_API_KEY=...     # Brave Search API (2000 req/mois gratuit)
TAVILY_API_KEY=...            # Tavily (1000 req/mois gratuit)
```

### 6.2 Admin UI — provider web search

La page admin existante `app/(app)/admin/` (ou `settings/`) doit exposer :

- Provider par défaut (dropdown: Brave / Tavily / DuckDuckGo)
- Statut de la clé API configurée (masqué sauf pour instance_admin)
- Ligne de statut: "✅ Brave Search configuré · 1847 req restantes" (si API supportée)

Ces valeurs sont stockées dans `orchestrator.yaml` via le pattern `OrchestratorConfigClient` existant (amendment 82 / config-git).

---

## Partie 7 — Sécurité

### 7.1 Validation des tool inputs

Le `toolExecutor` ne trust jamais l'input du LLM :

```typescript
// Dans searchByProvider, avant toute utilisation de query:
const sanitizedQuery = String(query)
  .replace(/[\x00-\x1F\x7F]/g, ' ')   // strip C0/C1
  .normalize('NFC')
  .slice(0, 120)                        // hard cap 120 chars

if (sanitizedQuery.trim().length < 2) {
  return { tool_call_id: call.id, content: 'Query too short.', is_error: true }
}
```

### 7.2 SSRF sur tous les outbound HTTP

`assertNotPrivateHost(url)` est appelé **avant** chaque `fetch()` dans `web-search.ts` :
- URL des APIs Brave/Tavily (public, mais on vérifie quand même)
- Chaque URL dans les résultats (filtre silencieux, résultat exclu mais log)

### 7.3 Content sanitization des résultats

Les snippets retournés au LLM sont :
- Tronqués à 2000 chars par résultat
- `innerHTML` stripped (le contenu est déjà plain text depuis les API)
- NFC-normalized

### 7.4 Prompt injection dans les résultats web

Les résultats de recherche sont injectés dans les **tool result messages**, pas dans le system prompt ni le user prompt. Le SDK provider gère la séparation de contexte. Néanmoins, dans le `content` retourné par `toolExecutor`, entourer les snippets de balises explicites :

```
[EXTERNAL_WEB_RESULT_START]
[1] Title...
URL
Snippet...
[EXTERNAL_WEB_RESULT_END]
```

Ce pattern suit celui de `McpSkillClient` qui utilise `<EXTERNAL_TOOL_RESULT skill="...">`.

### 7.5 Rate limiting interne

Deux niveaux de protection :

**Par run (boucle tool_use) :** le hard cap `maxToolIterations` (défaut 5, max 10) limité à 10 appels par boucle par nœud.

**Par projet / heure (global) :** pour éviter qu'un projet mal configuré consomme des centaines de requêtes search API :

```typescript
// lib/agents/tools/web-search.ts — dans makeWebSearchExecutor(), avant searchByProvider()
// Compter les appels web_search depuis le début de l'heure pour ce projet
const hourKey = `ws:${projectId}:${Math.floor(Date.now() / 3_600_000)}`
// Stockage en mémoire process (Map) ou Redis si disponible. Pas de DB.
const callCount = webSearchCallCount.get(hourKey) ?? 0
const PROJECT_HOURLY_LIMIT = 60  // 60 appels/projet/heure

if (callCount >= PROJECT_HOURLY_LIMIT) {
  return { tool_call_id: call.id, content: 'Web search quota reached for this project (60/h). Try again later.', is_error: true }
}
webSearchCallCount.set(hourKey, callCount + 1)
```

`projectId` est passé dans `nodeCtx`. La Map est un singleton process-level (acceptable pour un processus Next.js single-replica ; en multi-replica, remplacer par Redis `INCR` avec TTL).

---

## Partie 8 — Tests

### 8.1 Unit tests — boucle tool_use

**`tests/llm/tool-use-loop.test.ts`**

```typescript
describe('DirectLLMClient — tool_use loop: Anthropic', () => {
  it('retourne directement si pas de tool_calls dans la réponse', async () => { ... })
  it('exécute une itération de tool_call et retourne', async () => { ... })
  it('s\'arrête à maxToolIterations (hard cap 10)', async () => { ... })
  it('accumule les tokens de toutes les itérations', async () => { ... })
  it('ne throw pas si toolExecutor retourne is_error: true', async () => { ... })
})

describe('DirectLLMClient — tool_use loop: OpenAI', () => {
  // Même suite avec mock OpenAI
})

describe('DirectLLMClient — stream() avec tools', () => {
  it('appelle onChunk une fois avec le contenu final', async () => { ... })
})
```

**`tests/agents/tools/web-search.test.ts`**

```typescript
describe('WebSearchExecutor', () => {
  it('filtre silencieusement les URLs privées (192.168.x)', async () => { ... })
  it('retourne is_error:true si API key manquante', async () => { ... })
  it('retourne is_error:true avec message lisible si provider timeout', async () => { ... })
  it('tronque les queries > 120 chars', async () => { ... })
  it('logge dans SourceTrustEvent pour chaque URL valide', async () => { ... })
  it('limite max_results à 10', async () => { ... })
})
```

**`tests/agents/runner-web-search.test.ts`**

```typescript
describe('Runner — WRITER avec web_search', () => {
  it('injecte WEB_SEARCH_TOOL dans ChatOptions quand enable_web_search=true', async () => { ... })
  it('n\'injecte PAS les tools quand enable_web_search=false', async () => { ... })
  it('stocke tool_calls_trace dans Node.metadata', async () => { ... })
  it('émet tool_call_progress SSE event', async () => { ... })
})
```

**`tests/llm/mock-client.test.ts`** — test du `setNextToolCallResponse()` :

```typescript
it('MockLLMClient.chat() appelle toolExecutor si toolCallQueue non vide', async () => {
  const mock = new MockLLMClient()
  mock.setNextToolCallResponse([{ id: 't1', name: 'web_search', input: { query: 'test' } }], 'final content')
  
  const executor = vi.fn().mockResolvedValue([{ tool_call_id: 't1', content: 'results...' }])
  const result = await mock.chat([], { model: 'mock', tools: [WEB_SEARCH_TOOL], toolExecutor: executor })
  
  expect(executor).toHaveBeenCalledOnce()
  expect(result.content).toBe('final content')
  expect(result.tool_calls_trace).toHaveLength(1)
})
```

### 8.2 Integration tests

**`tests/api/runs-web-search.test.ts`**

```typescript
it('POST /api/runs avec enable_web_search:true stocke enable_web_search dans run_config', async () => { ... })
it('POST /api/runs sans enable_web_search → run_config.enable_web_search=false', async () => { ... })
```

---

## Partie 9 — Migration et Backward Compat

**Zéro migration de schema.** Aucun nouveau champ Prisma requis :
- `enable_web_search` vit dans `Run.run_config` (Json existant)
- `tool_calls_trace` vit dans `Node.metadata` (Json existant)
- `SourceTrustEvent` existing model with `source_type: 'web_search'` already supports it

**Backward compat parfaite :**
- `ChatOptions.tools` absent → comportement identique à aujourd'hui
- Tous les agents existants passent `options` sans `tools` → aucun comportement change
- `ChatResult.tool_calls_trace` absent → aucun consumer breaking
- `MockLLMClient` : `setNextToolCallResponse` est additive — l'API existante inchangée

---

## Partie 10 — Phases d'implémentation

### Phase 1 — Core LLM layer (autonome, sans web search)

**Durée estimée : 1 PR**

Fichiers modifiés :
- `lib/llm/interface.ts` : `ToolDefinition`, `ToolCall`, `ToolResult`, `ToolCallIteration`, extensions `ChatOptions` + `ChatResult`
- `lib/llm/client.ts` : boucle tool_use dans `callAnthropic`, `callOpenAI`, `callGemini` + extraction de `runOpenAIToolLoop` helper
- `lib/llm/litellm-client.ts` : utilise `runOpenAIToolLoop`
- `lib/llm/mock-client.ts` : `setNextToolCallResponse`, support `toolCallQueue`
- Tests : `tests/llm/tool-use-loop.test.ts`, mise à jour `tests/llm/mock-client.test.ts`
- `npx tsc --noEmit` passe, tous les tests existants passent

### Phase 2 — Tool registry + Web search executor

**Durée estimée : 1 PR**

Fichiers créés/modifiés :
- `lib/execution/run-config.ts` (nouveau)
- `lib/agents/tools/registry.ts` (nouveau)
- `lib/agents/tools/web-search.ts` (nouveau)
- `lib/agents/tools/index.ts` (nouveau)
- Tests : `tests/agents/tools/web-search.test.ts`

### Phase 3 — Injection dans runner + WriterOutput extension

**Durée estimée : 1 PR — à intégrer avec Phase 2 ou séparément**

Fichiers modifiés :
- `lib/agents/writer.ts` : `execution_meta.tool_calls_trace` optional field
- `lib/agents/runner.ts` : injection tools dans WRITER cas + tool_call_progress SSE
- `types/events.ts` : `tool_call_progress` event
- Tests : `tests/agents/runner-web-search.test.ts`

### Phase 4 — API + UI

**Durée estimée : 1 PR**

Fichiers modifiés :
- `app/api/runs/route.ts` : `enable_web_search` dans body schema
- `app/(app)/projects/[projectId]/runs/new/page.tsx` : toggle + form field
- `locales/en.json` + `locales/fr.json` : clés i18n
- `openapi/v1.yaml` : `enable_web_search` dans `CreateRunRequest`

---

## Acceptance Criteria (exhaustif)

**LLM tool_use core :**
- [ ] `DirectLLMClient.chat()` avec `tools + toolExecutor` → exécute la boucle correctement pour Anthropic
- [ ] `DirectLLMClient.chat()` avec `tools + toolExecutor` → exécute la boucle correctement pour OpenAI
- [ ] `DirectLLMClient.chat()` avec `tools + toolExecutor` → exécute la boucle correctement pour Gemini
- [ ] `LiteLLMClient.chat()` avec tools → même comportement
- [ ] Boucle s'arrête à `maxToolIterations` — jamais throw
- [ ] Tokens de toutes les itérations comptabilisés dans `ChatResult.tokensIn/tokensOut`
- [ ] `ChatOptions` sans `tools` → comportement identique à aujourd'hui pour tous les providers
- [ ] Tous les tests unitaires existants passent sans modification

**Web search :**
- [ ] `BRAVE_SEARCH_API_KEY` absent → `toolExecutor` retourne `is_error: true` avec message lisible, boucle continue
- [ ] URL privée (192.168.x) dans résultats → filtrée silencieusement, jamais envoyée au LLM
- [ ] Query > 120 chars → tronquée à 120
- [ ] `max_results > 10` → clamped à 10
- [ ] Chaque URL valide loguée dans `SourceTrustEvent`
- [ ] `makeWebSearchExecutor()` ne throw jamais — toujours `ToolResult[]`

**Intégration :**
- [ ] Run avec `enable_web_search: true` → WRITER node reçoit `WEB_SEARCH_TOOL` dans ses ChatOptions
- [ ] Run avec `enable_web_search: false` (défaut) → aucun outil injecté, comportement identique
- [ ] `tool_calls_trace` stocké dans `Node.metadata` quand ≥1 tool call effectué
- [ ] SSE event `tool_call_progress` émis pendant l'exécution du tool
- [ ] NodeCard UI affiche la query et le nb de résultats pendant l'exécution

**API/UI :**
- [ ] `POST /api/runs` accepte `enable_web_search: true` — stocké dans `run_config`
- [ ] Toggle web search visible dans "Options avancées" du formulaire new run
- [ ] Toutes les strings UI via `t()` avec clés fr/en
- [ ] `openapi/v1.yaml` à jour
- [ ] `npx tsc --noEmit` passe avec zéro erreurs

---

## Impact sur le plan multi-format artifact

La spec `multi-format-artifact-output.feature.md` **n'est pas affectée** par ce refactor. Les deux features sont orthogonales :
- `output_file_format` vit dans `PlannerNode.metadata` → post-processeur dans `lib/agents/runner.ts`
- `enable_web_search` vit dans `RunConfig` → injection de tools dans `ChatOptions`

Les deux peuvent être implémentées en parallèle. La seule dépendance : si un WRITER node a à la fois `output_file_format: "csv"` ET web search activé, les deux chemins s'exécutent séquentiellement : d'abord la boucle tool_use (pendant `llm.chat()`), puis le converter sur le contenu final retourné. Ce n'est pas un conflit.

---

## Décisions d'architecture documentées

| # | Décision | Raison |
|---|---|---|
| A | Boucle tool_use dans `ILLMClient`, pas dans les agents | Les agents (WRITER, PLANNER…) ne changent pas. Tool_use est une capacité du transport LLM, pas de l'agent. |
| B | `toolExecutor` callback passé dans `ChatOptions` | Le client LLM n'a pas accès à la DB ni au bus SSE. Le callback dans `ChatOptions` délègue l'exécution au caller (`lib/agents/runner.ts`), qui a accès à tout le contexte. |
| C | `stream()` avec tools → loop non-streaming + onChunk final | Streaming pendant outil = complexité N×. Acceptable en Phase 1 : la latence dominante est les appels HTTP de recherche, pas la génération de tokens. |
| D | Gemini IDs `${nodeCtx.node_id}_${Date.now()}_i_j` | Le SDK Gemini n'expose pas d'ID per-functionCall. IDs  incluant `node_id` + timestamp — uniques entre runs concurrents. |
| E | DuckDuckGo via HTML scraping | DDG n'a pas d'API publique. Le endpoint `/lite/` est stable et minimal. Fallback pour les instances sans clé API. |
| F | Hard cap `maxToolIterations = 10` dans `ILLMClient` | Prévient les boucles infinies causées par un LLM qui refuse de s'arrêter de chercher. `maxToolIterations: 5` est le défaut raisonnable. |
| G | Résultats web dans tool_result message, pas dans system prompt | Séparation de contexte : le LLM sait que les résultats viennent d'un outil externe, pas du system. Meilleure attribution des sources. |
| H | `ToolInjectionLLMClient` class plutôt qu'objet inline | Un objet `{ chat, stream }` inline serait silencieusement invalide si `ILLMClient` gagnait de nouveaux méthodes. La classe implémente explicitement l'interface — erreur TypeScript immédiate. |
| I | Context window guard dans la boucle | Les modèles à petite fenêtre (Ollama 8k) font échouer le 2e appel si les résultats de recherche saturent le contexte. La garde arrête proprement la boucle avec le contenu partiel. |
| J | IMAGE generation via `IImageClient` (pas `ILLMClient` + tools) | Les API image (DALL-E, Imagen) n'ont pas de contexte messages, pas de token counting, sortie binaire, coût fixe par image. Forcer `ILLMClient` reviendrait à casser son contrat (`content: string`, `tokensIn/Out`). Interface séparée = contrat explicite + erreur TypeScript immédiate si mal utilisé. Voir `multi-format-artifact-output.feature.md` §4.2. |
