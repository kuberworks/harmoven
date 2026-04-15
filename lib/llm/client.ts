// lib/llm/client.ts
// DirectLLMClient — routes ILLMClient calls to the correct provider SDK.
// Spec: TECHNICAL.md Sections 6, 7, 17, 21, Amendment 71.
//
// Providers supported:
//   anthropic  → @anthropic-ai/sdk
//   openai     → openai (npm)
//   gemini     → @google/generative-ai
//   cometapi   → openai (OpenAI-compatible; base_url = api.cometapi.com/v1)
//   ollama     → openai (OpenAI-compatible; base_url = localhost:11434/v1)
//   litellm    → openai (OpenAI-compatible; user-supplied base_url)
//   mistral    → openai (OpenAI-compatible; base_url = api.mistral.ai/v1)
//   custom     → openai (OpenAI-compatible; user-supplied base_url)
//
// Factory: createLLMClient(yamlPath?)
//   litellm.enabled in orchestrator.yaml → LiteLLMClient (opt-in sidecar)
//   else → DirectLLMClient using profiles_active list

import fs   from 'fs'
import path from 'path'
import yaml from 'js-yaml'

import Anthropic from '@anthropic-ai/sdk'
import OpenAI    from 'openai'
import {
  GoogleGenerativeAI,
  type Content as GeminiContent,
  type FunctionDeclarationSchema,
} from '@google/generative-ai'

import type { ILLMClient, ChatMessage, ChatOptions, ChatResult, ToolCall, ToolResult, ToolCallIteration } from '@/lib/llm/interface'
import type { LlmProfile, Prisma as PrismaTypes }            from '@prisma/client'
import { BUILT_IN_PROFILES, loadActiveProfiles, detectFallbackProfileId, dbRowToLlmProfileConfig } from './profiles'
import { selectByTier, selectLlm } from './selector'
import type { SelectLlmInput } from './selector'
import type { LlmProfileConfig } from './profiles'
import { validateLLMBaseUrl, assertLocalHost } from '@/lib/security/ssrf-protection'
import { decryptLlmKey }                      from '@/lib/utils/llm-key-crypto'
import { getLlmPlugin, getPluginProfiles }    from './plugin-loader'

// ─── Orchestrator YAML types ───────────────────────────────────────────────────

interface OrchestratorYaml {
  llm?: {
    profiles_active?: string[]
  }
  litellm?: {
    enabled?: boolean
    address?: string
  }
}

function readOrchestratorConfig(yamlPath?: string): OrchestratorYaml {
  const filePath = yamlPath ?? path.resolve(process.cwd(), 'orchestrator.yaml')
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return (yaml.load(raw) as OrchestratorYaml) ?? {}
  } catch {
    return {}
  }
}

// ─── Helper — extract system message ──────────────────────────────────────────

function splitMessages(messages: ChatMessage[]): {
  system: string | undefined
  userMessages: ChatMessage[]
} {
  const systemMsgs = messages.filter(m => m.role === 'system')
  const userMessages = messages.filter(m => m.role !== 'system')
  const system = systemMsgs.length > 0
    ? systemMsgs.map(m => m.content).join('\n\n')
    : undefined
  return { system, userMessages }
}

// ─── Per-profile SDK client cache ────────────────────────────────────────────
// SDK clients maintain persistent HTTP/2 connections. Recreating them per call
// defeats connection pooling. We cache by profile.id (stable key).
//
// SECURITY: OpenAI cache has a 5-minute TTL to bound the DNS rebinding attack window.
// Without TTL, validateLLMBaseUrl() runs once at creation — an attacker controlling DNS
// could change the resolution after the first call and bypass the SSRF check indefinitely.
// After TTL expiry the client is rebuilt and the URL re-validated against current DNS.
// Anthropic clients use a fixed public endpoint (no custom base_url) — no rebinding risk.

const _anthropicCache = new Map<string, Anthropic>()

interface OpenAICacheEntry { client: OpenAI; expiresAt: number }
const _openaiCache       = new Map<string, OpenAICacheEntry>()
const OPENAI_CACHE_TTL_MS = 5 * 60_000  // 5 min — re-validates base_url DNS on expiry

// ─── Anthropic provider ────────────────────────────────────────────────────────

function buildAnthropicClient(profile: LlmProfileConfig): Anthropic {
  const cached = _anthropicCache.get(profile.id)
  if (cached) return cached
  const apiKey = process.env[profile.api_key_env ?? 'ANTHROPIC_API_KEY']
  if (!apiKey) throw new Error(`[LLM] ${profile.api_key_env ?? 'ANTHROPIC_API_KEY'} is not set`)
  const client = new Anthropic({ apiKey })
  _anthropicCache.set(profile.id, client)
  return client
}

async function callAnthropic(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
): Promise<ChatResult> {
  const client = buildAnthropicClient(profile)
  const { system, userMessages } = splitMessages(messages)

  // ── Native Anthropic server-side web search ───────────────────────────────
  // When anthropicNativeWebSearch=true, use Anthropic's built-in web_search
  // server tool. Anthropic's API executes the searches internally and returns
  // a single end_turn response — no toolExecutor loop needed on our side.
  // Any custom tools/toolExecutor injected by ToolInjectionLLMClient are
  // intentionally ignored here; external providers (OpenAI, Gemini) use them.
  if (options.anthropicNativeWebSearch) {
    // Type cast: server tools use { type, name } not { name, description, input_schema }.
    // The Anthropic SDK accepts them but the TS union type requires an explicit cast.
    const serverTool = { type: 'web_search_20250305', name: 'web_search' } as unknown as Anthropic.Tool
    const wsStream = await client.messages.stream(
      {
        model:      profile.model_string,
        max_tokens: Math.min(options.maxTokens ?? 4096, profile.max_output_tokens ?? Infinity),
        ...(system ? { system } : {}),
        messages: userMessages.map(m => ({
          role:    m.role as 'user' | 'assistant',
          content: m.content,
        })),
        tools: [serverTool],
      },
      { signal: options.signal },
    )
    const wsResp = await wsStream.finalMessage()
    // Collect all text blocks — citations are embedded in text by Claude,
    // and web_search_tool_result / server_tool_use blocks are skipped here.
    const wsTextBlocks = wsResp.content.filter(b => b.type === 'text')
    const wsContent    = wsTextBlocks.map(b => ('text' in b ? (b as Anthropic.TextBlock).text : '')).join('')
    return {
      content:  wsContent,
      tokensIn:  wsResp.usage.input_tokens,
      tokensOut: wsResp.usage.output_tokens,
      costUsd:   0,
      model:     wsResp.model,
    }
  }

  // If no tools, use simple non-looping path (backward compat).
  // Use .stream()/.finalMessage() instead of .create() so Anthropic does not
  // reject requests that take > 10 minutes (streaming is required for those).
  if (!options.tools?.length || !options.toolExecutor) {
    const stream = await client.messages.stream(
      {
        model:      profile.model_string,
        max_tokens: Math.min(options.maxTokens ?? 4096, profile.max_output_tokens ?? Infinity),
        ...(system ? { system } : {}),
        messages: userMessages.map(m => ({
          role:    m.role as 'user' | 'assistant',
          content: m.content,
        })),
      },
      { signal: options.signal },
    )
    const response = await stream.finalMessage()
    const textBlocks = response.content.filter(b => b.type === 'text')
    const content    = textBlocks.map(b => ('text' in b ? b.text : '')).join('')
    return {
      content,
      tokensIn:  response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      costUsd:   0,
      model:     response.model,
    }
  }

  // ── Agentic tool_use loop (§2.2) ─────────────────────────────────────────
  const anthropicTools = options.tools.map(t => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.input_schema as Anthropic.Tool['input_schema'],
  }))

  type AnthropicMsg = Anthropic.MessageParam
  let currentMessages: AnthropicMsg[] = userMessages.map(m => ({
    role:    m.role as 'user' | 'assistant',
    content: m.content,
  }))

  let totalIn  = 0
  let totalOut = 0
  const trace: ToolCallIteration[] = []
  const maxIter = Math.min(options.maxToolIterations ?? 5, 10)
  const CONTEXT_BUDGET = options.maxTokens ? options.maxTokens * 10 : 80_000
  let iteration = 0

  while (true) {
    if (totalIn > CONTEXT_BUDGET && iteration > 0) {
      return {
        content: '[context budget reached — partial result from previous iterations]',
        tokensIn: totalIn, tokensOut: totalOut,
        model:    profile.model_string,
        costUsd:  0,
        tool_calls_trace: trace.length > 0 ? trace : undefined,
      }
    }

    // Use .stream()/.finalMessage() to satisfy Anthropic's requirement for
    // streaming on requests that may exceed 10 minutes.
    const iterStream = await client.messages.stream(
      {
        model:      profile.model_string,
        max_tokens: Math.min(options.maxTokens ?? 4096, profile.max_output_tokens ?? Infinity),
        ...(system ? { system } : {}),
        messages:   currentMessages,
        tools:      anthropicTools,
        tool_choice: { type: 'auto' },
      },
      { signal: options.signal },
    )
    const resp = await iterStream.finalMessage()

    totalIn  += resp.usage.input_tokens
    totalOut += resp.usage.output_tokens

    const toolUseBlocks = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )
    const textContent = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    if (toolUseBlocks.length === 0) {
      return {
        content:  textContent,
        tokensIn: totalIn, tokensOut: totalOut,
        model:    resp.model,
        costUsd:  0,
        ...(trace.length > 0 ? { tool_calls_trace: trace } : {}),
      }
    }

    if (iteration >= maxIter) {
      return {
        content:  textContent || '[tool iteration limit reached]',
        tokensIn: totalIn, tokensOut: totalOut,
        model:    resp.model,
        costUsd:  0,
        tool_calls_trace: trace,
      }
    }

    const calls: ToolCall[] = toolUseBlocks.map(b => ({
      id:    b.id,
      name:  b.name,
      input: b.input as Record<string, unknown>,
    }))
    const results: ToolResult[] = await options.toolExecutor(calls, options.signal)

    trace.push({
      iteration: iteration + 1,
      tool_calls:   calls,
      tool_results: results,
      tokens_in:  resp.usage.input_tokens,
      tokens_out: resp.usage.output_tokens,
    })

    // Append assistant turn (with tool_use blocks) + user turn (with tool_results)
    currentMessages = [
      ...currentMessages,
      {
        role:    'assistant',
        content: resp.content as unknown as Anthropic.ContentBlockParam[],
      },
      {
        role:    'user',
        content: results.map(r => ({
          type:        'tool_result' as const,
          tool_use_id: r.tool_call_id,
          content:     r.content,
          ...(r.is_error ? { is_error: true } : {}),
        })),
      },
    ]

    iteration++
  }
}

async function streamAnthropic(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
  onChunk:  (chunk: string) => void,
): Promise<ChatResult> {
  const client = buildAnthropicClient(profile)
  const { system, userMessages } = splitMessages(messages)

  const stream = await client.messages.stream(
    {
      model:      profile.model_string,
      max_tokens: Math.min(options.maxTokens ?? 4096, profile.max_output_tokens ?? Infinity),
      ...(system ? { system } : {}),
      messages: userMessages.map(m => ({
        role:    m.role as 'user' | 'assistant',
        content: m.content,
      })),
    },
    { signal: options.signal },
  )

  let fullText = ''
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      onChunk(event.delta.text)
      fullText += event.delta.text
    }
  }

  const final = await stream.finalMessage()
  return {
    content:   fullText,
    tokensIn:  final.usage.input_tokens,
    tokensOut: final.usage.output_tokens,
    costUsd:   0,
    model:     final.model,
  }
}

// ─── OpenAI + OpenAI-compatible providers ─────────────────────────────────────

async function buildOpenAIClient(profile: LlmProfileConfig): Promise<OpenAI> {
  // SEC-C-01: Re-validate base_url on EVERY call when a custom base_url is set.
  // The 5-min client cache is kept for connection reuse, but the SSRF check
  // runs unconditionally so a DNS rebinding attack cannot exploit the cache window.
  // For fixed public endpoints (no base_url) the check is skipped — no SSRF risk.
  //
  // SEC-C-02: For `local` jurisdiction providers, REQUIRE the URL to resolve to a
  // private/loopback address. This prevents a misconfigured orchestrator.yaml from
  // leaking CRITICAL-confidentiality data to a public server.
  if (profile.base_url) {
    if (profile.jurisdiction === 'local') {
      await assertLocalHost(profile.base_url)
    } else {
      await validateLLMBaseUrl(profile.base_url)
    }
  }

  const cached = _openaiCache.get(profile.id)
  if (cached && Date.now() < cached.expiresAt) return cached.client

  // Key resolution order:
  //   1. config.api_key_enc  — encrypted key stored in DB (custom providers)
  //   2. process.env[api_key_env] — env var (built-in providers)
  //   3. 'no-key' fallback  — Ollama and open endpoints that require no auth
  let apiKey = 'no-key'
  if (profile.api_key_enc) {
    const decrypted = decryptLlmKey(profile.api_key_enc)
    if (decrypted) apiKey = decrypted
  } else if (profile.api_key_env) {
    apiKey = process.env[profile.api_key_env] ?? 'no-key'
  }

  // For Ollama the key is irrelevant — the server accepts any value.
  const client = new OpenAI({
    apiKey,
    ...(profile.base_url ? { baseURL: profile.base_url } : {}),
  })
  _openaiCache.set(profile.id, { client, expiresAt: Date.now() + OPENAI_CACHE_TTL_MS })
  return client
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map(m => ({ role: m.role, content: m.content }))
}

/**
 * runOpenAIToolLoop — shared agentic loop for all OpenAI-compatible providers.
 * Used by callOpenAI() and LiteLLMClient.
 */
export async function runOpenAIToolLoop(
  client:   OpenAI,
  profile:  { model_string: string; supports_tool_choice?: boolean },
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options:  ChatOptions,
  signal?:  AbortSignal,
): Promise<ChatResult> {
  const oaiTools = options.tools?.length
    ? options.tools.map(t => ({
        type:     'function' as const,
        function: {
          name:        t.name,
          description: t.description,
          parameters:  t.input_schema as Record<string, unknown>,
        },
      }))
    : undefined

  let currentMessages = [...messages]
  let totalIn  = 0
  let totalOut = 0
  const trace: ToolCallIteration[] = []
  const maxIter = Math.min(options.maxToolIterations ?? 5, 10)
  let iteration = 0
  let lastModel = profile.model_string

  // Providers that declare supports_tool_choice: false (e.g. MiniMax, Ollama) return
  // empty choices when tool_choice is injected. Skip injection entirely and let the
  // pre_search_context embedded in the user message serve as the search fallback.
  const canInjectTools = profile.supports_tool_choice !== false

  while (true) {
    const resp = await client.chat.completions.create(
      {
        model:      profile.model_string,
        max_tokens: options.maxTokens ?? 4096,
        messages:   currentMessages,
        ...(oaiTools && canInjectTools ? { tools: oaiTools, tool_choice: 'auto' as const } : {}),
      },
      { signal },
    )

    const msg  = resp.choices?.[0]?.message
    if (resp.model) lastModel = resp.model
    totalIn  += resp.usage?.prompt_tokens     ?? 0
    totalOut += resp.usage?.completion_tokens ?? 0

    if (!msg?.tool_calls?.length || !options.toolExecutor) {
      const content = msg?.content ?? ''

      // Some OpenAI-compat providers (e.g. MiniMax via CometAPI) return null/empty
      // choices when tool_choice is injected but respond correctly without tools.
      // When this happens on the FIRST iteration, degrade gracefully: retry the same
      // request without tools so the LLM can produce content.
      // runner.ts already pre-fetches web_search_context into the user message as a
      // fallback, so search results are still available even without live tool calls.
      if (!content && iteration === 0 && oaiTools && options.toolExecutor) {
        console.warn('[runOpenAIToolLoop] Empty response with tools — retrying without tools (provider may not support tool_choice)')
        const plainResp = await client.chat.completions.create(
          {
            model:      profile.model_string,
            max_tokens: options.maxTokens ?? 4096,
            messages:   currentMessages,
          },
          { signal },
        )
        const plainMsg = plainResp.choices?.[0]?.message
        totalIn  += plainResp.usage?.prompt_tokens     ?? 0
        totalOut += plainResp.usage?.completion_tokens ?? 0
        if (plainResp.model) lastModel = plainResp.model
        return {
          content:  plainMsg?.content ?? '',
          tokensIn: totalIn, tokensOut: totalOut,
          model:    lastModel,
          costUsd:  0,
          ...(trace.length > 0 ? { tool_calls_trace: trace } : {}),
        }
      }

      return {
        content,
        tokensIn: totalIn, tokensOut: totalOut,
        model:    lastModel,
        costUsd:  0,
        ...(trace.length > 0 ? { tool_calls_trace: trace } : {}),
      }
    }

    if (iteration >= maxIter) {
      return {
        content:  msg.content ?? '[tool iteration limit reached]',
        tokensIn: totalIn, tokensOut: totalOut,
        model:    lastModel,
        costUsd:  0,
        tool_calls_trace: trace,
      }
    }

    const calls: ToolCall[] = msg.tool_calls
      .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
      .map(tc => {
        let parsedInput: Record<string, unknown> = {}
        try {
          parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>
        } catch {
          // Open-source model: malformed JSON arguments — don't throw, signal error
          return {
            id:    tc.id,
            name:  tc.function.name,
            input: { __parse_error: tc.function.arguments },
          }
        }
        return { id: tc.id, name: tc.function.name, input: parsedInput }
      })
    const results: ToolResult[] = await options.toolExecutor(calls, signal)

    trace.push({
      iteration: iteration + 1,
      tool_calls:   calls,
      tool_results: results,
      tokens_in:  resp.usage?.prompt_tokens     ?? 0,
      tokens_out: resp.usage?.completion_tokens ?? 0,
    })

    currentMessages = [
      ...currentMessages,
      {
        role:       'assistant' as const,
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

async function callOpenAI(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
): Promise<ChatResult> {
  const client = await buildOpenAIClient(profile)
  const oaiMessages = toOpenAIMessages(messages)

  // If tools present, use the agentic loop
  if (options.tools?.length && options.toolExecutor) {
    return runOpenAIToolLoop(client, profile, oaiMessages, options, options.signal)
  }

  const completion = await client.chat.completions.create(
    {
      model:      profile.model_string,
      max_tokens: options.maxTokens ?? 4096,
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

async function streamOpenAI(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
  onChunk:  (chunk: string) => void,
): Promise<ChatResult> {
  const client = await buildOpenAIClient(profile)

  // Use raw create({ stream: true }) iteration instead of the higher-level
  // client.chat.completions.stream() helper.
  //
  // The stream() helper calls finalizeChatCompletion() at the end, which
  // throws OpenAIError('missing finish_reason for choice 0') when an
  // OpenAI-compatible provider (CometAPI, Ollama, Mistral, custom) omits
  // finish_reason on the final SSE chunk — a common non-strict behaviour.
  // Raw iteration bypasses finalizeChatCompletion() entirely.
  const stream = await client.chat.completions.create(
    {
      model:      profile.model_string,
      max_tokens: options.maxTokens ?? 4096,
      messages:   toOpenAIMessages(messages),
      stream:     true,
    },
    { signal: options.signal },
  )

  let fullText  = ''
  let modelName = profile.model_string
  let tokensIn  = 0
  let tokensOut = 0
  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content ?? ''
    if (text) { onChunk(text); fullText += text }
    if (chunk.model) modelName = chunk.model
    // Some providers send usage in the final chunk
    if (chunk.usage) {
      tokensIn  = chunk.usage.prompt_tokens     ?? 0
      tokensOut = chunk.usage.completion_tokens ?? 0
    }
  }

  return {
    content:   fullText,
    tokensIn,
    tokensOut,
    costUsd:   0,
    model:     modelName,
  }
}

// ─── Google Gemini provider ────────────────────────────────────────────────────

function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  // Gemini uses 'model' role instead of 'assistant'
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
}

async function callGemini(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
): Promise<ChatResult> {
  const apiKey = process.env[profile.api_key_env ?? 'GOOGLE_API_KEY']
  if (!apiKey) throw new Error(`[LLM] ${profile.api_key_env ?? 'GOOGLE_API_KEY'} is not set`)

  const genAI = new GoogleGenerativeAI(apiKey)
  const { system } = splitMessages(messages)

  // If no tools, use simple non-looping path (backward compat)
  if (!options.tools?.length || !options.toolExecutor) {
    const model = genAI.getGenerativeModel({
      model: profile.model_string,
      ...(system ? { systemInstruction: system } : {}),
      generationConfig: { maxOutputTokens: options.maxTokens ?? 4096 },
    })
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const result   = await model.generateContent({ contents: toGeminiContents(messages) })
    const response = result.response
    const content  = response.text()
    return {
      content,
      tokensIn:  response.usageMetadata?.promptTokenCount      ?? 0,
      tokensOut: response.usageMetadata?.candidatesTokenCount   ?? 0,
      model:     profile.model_string,
      costUsd:   0,
    }
  }

  // ── Agentic function_calling loop (§2.4) ─────────────────────────────────
  const functionDeclarations = options.tools.map(t => ({
    name:        t.name,
    description: t.description,
    parameters:  t.input_schema as unknown as FunctionDeclarationSchema,
  }))

  const geminiModel = genAI.getGenerativeModel({
    model: profile.model_string,
    ...(system ? { systemInstruction: system } : {}),
    tools: [{ functionDeclarations }],
    generationConfig: { maxOutputTokens: options.maxTokens ?? 4096 },
  })

  let contents = toGeminiContents(messages)
  let totalIn  = 0
  let totalOut = 0
  const trace: ToolCallIteration[] = []
  const maxIter = Math.min(options.maxToolIterations ?? 5, 10)
  let iteration = 0

  while (true) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const resp = await geminiModel.generateContent({ contents })

    totalIn  += resp.response.usageMetadata?.promptTokenCount      ?? 0
    totalOut += resp.response.usageMetadata?.candidatesTokenCount  ?? 0

    const parts     = resp.response.candidates?.[0]?.content?.parts ?? []
    const funcCalls = parts.filter(p => p.functionCall)
    const textContent = parts.filter(p => p.text).map(p => p.text ?? '').join('')

    if (funcCalls.length === 0) {
      return {
        content:  textContent,
        tokensIn: totalIn, tokensOut: totalOut,
        model:    profile.model_string,
        costUsd:  0,
        ...(trace.length > 0 ? { tool_calls_trace: trace } : {}),
      }
    }

    if (iteration >= maxIter) {
      return {
        content:  textContent || '[tool iteration limit reached]',
        tokensIn: totalIn, tokensOut: totalOut,
        model:    profile.model_string,
        costUsd:  0,
        tool_calls_trace: trace,
      }
    }

    const calls: ToolCall[] = funcCalls.map((p, i) => ({
      // Gemini doesn't expose per-functionCall IDs — generate stable unique IDs
      id:    `gemini_${Date.now()}_${iteration}_${i}`,
      name:  p.functionCall!.name,
      input: p.functionCall!.args as Record<string, unknown>,
    }))
    const results: ToolResult[] = await options.toolExecutor(calls, options.signal)

    trace.push({
      iteration: iteration + 1,
      tool_calls:   calls,
      tool_results: results,
      tokens_in:  resp.response.usageMetadata?.promptTokenCount     ?? 0,
      tokens_out: resp.response.usageMetadata?.candidatesTokenCount ?? 0,
    })

    // Append model turn (functionCall) + user turn (functionResponse)
    contents = [
      ...contents,
      {
        role:  'model',
        parts: funcCalls.map(p => ({ functionCall: p.functionCall })),
      },
      {
        role:  'user',
        parts: results.map((r, i) => ({
          functionResponse: {
            name:     calls[i]?.name ?? r.tool_call_id,
            response: { content: r.content, is_error: r.is_error ?? false },
          },
        })),
      },
    ] as GeminiContent[]

    iteration++
  }
}

async function streamGemini(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
  onChunk:  (chunk: string) => void,
): Promise<ChatResult> {
  const apiKey = process.env[profile.api_key_env ?? 'GOOGLE_API_KEY']
  if (!apiKey) throw new Error(`[LLM] ${profile.api_key_env ?? 'GOOGLE_API_KEY'} is not set`)

  const genAI = new GoogleGenerativeAI(apiKey)
  const { system } = splitMessages(messages)
  const model = genAI.getGenerativeModel({
    model: profile.model_string,
    ...(system ? { systemInstruction: system } : {}),
    generationConfig: { maxOutputTokens: options.maxTokens ?? 4096 },
  })

  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const result  = await model.generateContentStream({ contents: toGeminiContents(messages) })
  let fullText  = ''
  let tokensIn  = 0
  let tokensOut = 0

  for await (const chunk of result.stream) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const text = chunk.text()
    if (text) { onChunk(text); fullText += text }
    tokensIn  += chunk.usageMetadata?.promptTokenCount     ?? 0
    tokensOut += chunk.usageMetadata?.candidatesTokenCount  ?? 0
  }

  return { content: fullText, tokensIn, tokensOut, costUsd: 0, model: profile.model_string }
}

// ─── DirectLLMClient ──────────────────────────────────────────────────────────

/**
 * DirectLLMClient — implements ILLMClient by routing to provider SDKs.
 *
 * `options.model` accepts:
 *   'fast' | 'balanced' | 'powerful'  → resolved via selectByTier()
 *   any profile id                    → resolved directly (e.g. 'claude-haiku-4-5-20251001')
 *   any model string (provider-native) → attempted as-is on the default provider
 */

/** Compute cost in USD from profile pricing and actual token counts. */
function computeCostUsd(profile: LlmProfileConfig, tokensIn: number, tokensOut: number): number {
  return (
    (tokensIn  / 1_000_000) * Number(profile.cost_per_1m_input_tokens)  +
    (tokensOut / 1_000_000) * Number(profile.cost_per_1m_output_tokens)
  )
}

export class DirectLLMClient implements ILLMClient {
  private readonly profiles: LlmProfileConfig[]
  readonly name = 'direct'

  constructor(profiles?: LlmProfileConfig[]) {
    this.profiles = profiles ?? BUILT_IN_PROFILES
  }

  // ── Profile resolution ──────────────────────────────────────────────────────

  private resolveProfile(
    modelTierOrId: string,
    ctx?: ChatOptions['selectionContext'],
  ): LlmProfileConfig {
    const tier = modelTierOrId as 'fast' | 'balanced' | 'powerful'

    // Tier alias — use multi-criteria selectLlm() when selection context is available,
    // so confidentiality / jurisdiction / budget constraints are enforced.
    if (['fast', 'balanced', 'powerful'].includes(tier)) {
      if (ctx) {
        // When a specific LLM override is set (run-level llm_overrides feature),
        // allow cross-tier selection so the user's chosen model wins regardless of tier.
        // Otherwise limit candidates to the requested tier to prevent the cost scorer
        // from routing agents (classifier=fast, planner/reviewer=powerful) to cheap
        // models from other tiers (e.g. a 'balanced' budget model winning over 'fast'
        // or 'powerful' Anthropic profiles purely on cost).
        const tierCandidates = ctx.preferredLlmId
          ? this.profiles
          : this.profiles.filter(p => p.tier === tier)
        const input: SelectLlmInput = {
          node: {
            task_type:        ctx.task_type,
            complexity:       ctx.complexity,
            estimated_tokens: ctx.estimated_tokens,
          },
          confidentiality:  ctx.confidentiality,
          jurisdictionTags: ctx.jurisdictionTags ?? [],
          preferredLlmId:   ctx.preferredLlmId,
          budgetRemaining:  ctx.budgetRemaining,
          // Use tier-filtered candidates to enforce tier discipline.
          // Fall back to the full pool only if no same-tier profiles exist
          // (e.g. admin removed all 'fast' profiles from orchestrator.yaml).
          candidates: tierCandidates.length > 0 ? tierCandidates : this.profiles,
        }
        const selected = selectLlm(input)
        if (selected) return selected
        // No eligible model after hard constraints → fall through to tier fallback
      }
      const found = selectByTier(tier, this.profiles)
      if (found) return found
      throw new Error(`[DirectLLMClient] No active profile for tier "${tier}". Check orchestrator.yaml profiles_active.`)
    }

    // Direct profile ID
    const byId = this.profiles.find(p => p.id === modelTierOrId)
    if (byId) return byId

    // Direct model_string match (fallback for tests/dev)
    const byModel = this.profiles.find(p => p.model_string === modelTierOrId)
    if (byModel) return byModel

    throw new Error(`[DirectLLMClient] Unknown model/tier/id: "${modelTierOrId}"`)
  }

  // ── ILLMClient ──────────────────────────────────────────────────────────────

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const profile = this.resolveProfile(options.model, options.selectionContext)
    const result  = await this.dispatchChat(profile, messages, options)
    return { ...result, costUsd: computeCostUsd(profile, result.tokensIn, result.tokensOut) }
  }

  async stream(
    messages: ChatMessage[],
    options:  ChatOptions,
    onChunk:  (chunk: string) => void,
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const profile = this.resolveProfile(options.model, options.selectionContext)
    onModelResolved?.(profile.model_string ?? profile.id)

    // §2.5 — "loop then stream": when tools are present, run the full agentic
    // chat() loop (no streaming per-iteration), then emit the final content as
    // a single chunk. The latency is dominated by tool execution (e.g. HTTP
    // search calls), not by token generation.
    if (options.tools?.length) {
      const result = await this.dispatchChat(profile, messages, options)
      if (result.content) onChunk(result.content)
      return { ...result, costUsd: computeCostUsd(profile, result.tokensIn, result.tokensOut) }
    }

    const result  = await this.dispatchStream(profile, messages, options, onChunk)
    return { ...result, costUsd: computeCostUsd(profile, result.tokensIn, result.tokensOut) }
  }

  // ── Provider dispatch ────────────────────────────────────────────────────────

  private dispatchChat(
    profile:  LlmProfileConfig,
    messages: ChatMessage[],
    options:  ChatOptions,
  ): Promise<ChatResult> {
    switch (profile.provider) {
      case 'anthropic': return callAnthropic(profile, messages, options)
      case 'openai':    return callOpenAI(profile, messages, options)
      case 'cometapi':  return callOpenAI(profile, messages, options)  // OpenAI-compat
      case 'ollama':    return callOpenAI(profile, messages, options)  // OpenAI-compat
      case 'litellm':   return callOpenAI(profile, messages, options)  // OpenAI-compat
      case 'mistral':   return callOpenAI(profile, messages, options)  // OpenAI-compat
      case 'custom':    return callOpenAI(profile, messages, options)  // OpenAI-compat
      case 'gemini':    return callGemini(profile, messages, options)
      default: {
        const plugin = getLlmPlugin(profile.provider)
        if (plugin) return plugin.chat(profile, messages, options)
        throw new Error(`[DirectLLMClient] Unknown provider: "${profile.provider}"`)
      }
    }
  }

  private dispatchStream(
    profile:  LlmProfileConfig,
    messages: ChatMessage[],
    options:  ChatOptions,
    onChunk:  (chunk: string) => void,
  ): Promise<ChatResult> {
    switch (profile.provider) {
      case 'anthropic': return streamAnthropic(profile, messages, options, onChunk)
      case 'openai':    return streamOpenAI(profile, messages, options, onChunk)
      case 'cometapi':  return streamOpenAI(profile, messages, options, onChunk)  // OpenAI-compat
      case 'ollama':    return streamOpenAI(profile, messages, options, onChunk)  // OpenAI-compat
      case 'litellm':   return streamOpenAI(profile, messages, options, onChunk)  // OpenAI-compat
      case 'mistral':   return streamOpenAI(profile, messages, options, onChunk)  // OpenAI-compat
      case 'custom':    return streamOpenAI(profile, messages, options, onChunk)  // OpenAI-compat
      case 'gemini':    return streamGemini(profile, messages, options, onChunk)
      default: {
        const plugin = getLlmPlugin(profile.provider)
        if (plugin) return plugin.stream(profile, messages, options, onChunk)
        throw new Error(`[DirectLLMClient] Unknown provider: "${profile.provider}"`)
      }
    }
  }
}

// ─── createLLMClient factory ──────────────────────────────────────────────────

/**
 * Seed BUILT_IN_PROFILES entries for `activeIds` into the DB if they don't
 * already exist. Safe to call multiple times (upsert-on-conflict-do-nothing).
 * Only runs in non-test environments.
 */
async function seedMissingProfilesToDb(
  activeIds: string[],
  db: { llmProfile: { upsert: (args: PrismaTypes.LlmProfileUpsertArgs) => Promise<LlmProfile> } },
): Promise<void> {
  for (const id of activeIds) {
    const built = BUILT_IN_PROFILES.find(p => p.id === id)
    if (!built) continue
    try {
      await db.llmProfile.upsert({
        where: { id },
        // Only create if missing — never overwrite admin-customised rows.
        update: {},
        create: {
          id,
          provider:                 built.provider,
          model_string:             built.model_string,
          tier:                     built.tier,
          context_window:           built.context_window,
          cost_per_1m_input_tokens:  built.cost_per_1m_input_tokens,
          cost_per_1m_output_tokens: built.cost_per_1m_output_tokens,
          jurisdiction:             built.jurisdiction,
          trust_tier:               built.trust_tier,
          task_type_affinity:       built.task_type_affinity,
          enabled:                  true,
          // Store provider-specific config (base_url, api_key_env) in JSON column
          // so the admin API can override them without a schema migration.
          config: {
            ...(built.base_url         ? { base_url:         built.base_url         } : {}),
            ...(built.api_key_env      ? { api_key_env:      built.api_key_env      } : {}),
            ...(built.max_output_tokens != null ? { max_output_tokens: built.max_output_tokens } : {}),
          },
        },
      })
    } catch (err) {
      console.warn(`[LLM] Failed to seed profile "${id}" to DB (non-fatal):`, err)
    }
  }
}

/**
 * Async factory: reads orchestrator.yaml for LiteLLM opt-in and the list of
 * profiles to seed, then loads enabled LlmProfile rows from the database.
 *
 * Source-of-truth hierarchy:
 *   1. DB (LlmProfile table) — editable at runtime via POST/PATCH /api/admin/models.
 *   2. BUILT_IN_PROFILES catalog — seeded into DB on first use (upsert-never-overwrite).
 *   3. orchestrator.yaml profiles_active — controls which built-ins are seeded.
 *
 * @param yamlPath Optional override path to orchestrator.yaml.
 */
export async function createLLMClient(yamlPath?: string): Promise<ILLMClient> {
  if (process.env.NODE_ENV === 'test') {
    // Tests inject MockLLMClient directly — never call createLLMClient().
    throw new Error('[createLLMClient] Do not call createLLMClient() in tests — inject MockLLMClient directly.')
  }

  const config = readOrchestratorConfig(yamlPath)

  if (config.litellm?.enabled) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LiteLLMClient } = require('@/lib/llm/litellm-client') as { LiteLLMClient: new (address: string) => ILLMClient }
      const address = config.litellm.address ?? 'http://localhost:4000'
      console.info(`[LLM] Using LiteLLM sidecar at ${address}`)
      return new LiteLLMClient(address)
    } catch (err) {
      throw new Error(
        `[createLLMClient] litellm.enabled=true in orchestrator.yaml but lib/llm/litellm-client module not found. ` +
        `Either implement it or set litellm.enabled: false. Original error: ${String(err)}`,
      )
    }
  }

  // Lazy dynamic import: avoids circular deps at module load time.
  // Must use await import() (not require()) so webpack treats it as a proper
  // async import — synchronous require() of an async webpack module returns
  // an unresolved namespace where named exports are undefined.
  const { db } = await import('@/lib/db/client') as unknown as {
    db: {
      llmProfile: {
        findMany: (args: PrismaTypes.LlmProfileFindManyArgs) => Promise<LlmProfile[]>
        upsert:   (args: PrismaTypes.LlmProfileUpsertArgs)    => Promise<LlmProfile>
      }
    }
  }

  // Seed BUILT_IN_PROFILES for the active ids listed in orchestrator.yaml.
  // Upsert is idempotent — admin-customised rows are never overwritten.
  const activeIds = config.llm?.profiles_active ?? []
  if (activeIds.length > 0) {
    await seedMissingProfilesToDb(activeIds, db)
  } else {
    // No explicit list — auto-detect the first provider with a key configured.
    await seedMissingProfilesToDb([detectFallbackProfileId()], db)
  }

  // Load all enabled profiles from DB — this is the live source of truth.
  const rows = await db.llmProfile.findMany({ where: { enabled: true } })
  const dbProfiles: LlmProfileConfig[] = rows.map(dbRowToLlmProfileConfig)

  // Merge plugin profiles (runtime-only, not stored in DB).
  // DB-stored versions win when the same id exists in both (admin customisation preserved).
  const pluginProfiles = getPluginProfiles().filter(pp => !dbProfiles.find(p => p.id === pp.id))
  const profiles       = [...dbProfiles, ...pluginProfiles]

  if (profiles.length === 0) {
    // Absolute fallback — should never happen after seeding, but guard anyway.
    console.warn('[LLM] No enabled profiles in DB — using built-in defaults.')
    return new DirectLLMClient(loadActiveProfiles(activeIds.length > 0 ? activeIds : [detectFallbackProfileId()]))
  }

  return new DirectLLMClient(profiles)
}
