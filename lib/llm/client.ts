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
} from '@google/generative-ai'

import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from '@/lib/llm/interface'
import { BUILT_IN_PROFILES, loadActiveProfiles } from './profiles'
import { selectByTier, selectLlm } from './selector'
import type { SelectLlmInput } from './selector'
import type { LlmProfileConfig } from './profiles'

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

const _anthropicCache = new Map<string, Anthropic>()
const _openaiCache    = new Map<string, OpenAI>()

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

  const response = await client.messages.create(
    {
      model:      profile.model_string,
      max_tokens: options.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages: userMessages.map(m => ({
        role:    m.role as 'user' | 'assistant',
        content: m.content,
      })),
    },
    { signal: options.signal },
  )

  const textBlocks = response.content.filter(b => b.type === 'text')
  const content    = textBlocks.map(b => ('text' in b ? b.text : '')).join('')
  return {
    content,
    tokensIn:  response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    model:     response.model,
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
      max_tokens: options.maxTokens ?? 4096,
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
    model:     final.model,
  }
}

// ─── OpenAI + OpenAI-compatible providers ─────────────────────────────────────

function buildOpenAIClient(profile: LlmProfileConfig): OpenAI {
  const cached = _openaiCache.get(profile.id)
  if (cached) return cached
  const envKey = profile.api_key_env
  const apiKey = envKey ? (process.env[envKey] ?? 'no-key') : 'no-key'
  // For Ollama the key is irrelevant — the server accepts any value.
  const client = new OpenAI({
    apiKey,
    ...(profile.base_url ? { baseURL: profile.base_url } : {}),
  })
  _openaiCache.set(profile.id, client)
  return client
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map(m => ({ role: m.role, content: m.content }))
}

async function callOpenAI(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
): Promise<ChatResult> {
  const client = buildOpenAIClient(profile)

  const completion = await client.chat.completions.create(
    {
      model:      profile.model_string,
      max_tokens: options.maxTokens ?? 4096,
      messages:   toOpenAIMessages(messages),
    },
    { signal: options.signal },
  )

  const choice  = completion.choices[0]
  const content = choice?.message?.content ?? ''
  return {
    content,
    tokensIn:  completion.usage?.prompt_tokens     ?? 0,
    tokensOut: completion.usage?.completion_tokens ?? 0,
    model:     completion.model,
  }
}

async function streamOpenAI(
  profile:  LlmProfileConfig,
  messages: ChatMessage[],
  options:  ChatOptions,
  onChunk:  (chunk: string) => void,
): Promise<ChatResult> {
  const client = buildOpenAIClient(profile)

  const stream = await client.chat.completions.stream(
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
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? ''
    if (text) { onChunk(text); fullText += text }
    if (chunk.model) modelName = chunk.model
  }

  const final = await stream.finalChatCompletion()
  return {
    content:   fullText,
    tokensIn:  final.usage?.prompt_tokens     ?? 0,
    tokensOut: final.usage?.completion_tokens ?? 0,
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
  const model = genAI.getGenerativeModel({
    model: profile.model_string,
    ...(system ? { systemInstruction: system } : {}),
    generationConfig: { maxOutputTokens: options.maxTokens ?? 4096 },
  })

  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const result = await model.generateContent({ contents: toGeminiContents(messages) })
  const response = result.response
  const content  = response.text()

  return {
    content,
    tokensIn:  response.usageMetadata?.promptTokenCount      ?? 0,
    tokensOut: response.usageMetadata?.candidatesTokenCount   ?? 0,
    model:     profile.model_string,
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

  return { content: fullText, tokensIn, tokensOut, model: profile.model_string }
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
          candidates:       this.profiles,
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
    return this.dispatchChat(profile, messages, options)
  }

  async stream(
    messages: ChatMessage[],
    options:  ChatOptions,
    onChunk:  (chunk: string) => void,
  ): Promise<ChatResult> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const profile = this.resolveProfile(options.model, options.selectionContext)
    return this.dispatchStream(profile, messages, options, onChunk)
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
      case 'gemini':    return callGemini(profile, messages, options)
      default:
        throw new Error(`[DirectLLMClient] Unknown provider: "${profile.provider}"`)
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
      case 'gemini':    return streamGemini(profile, messages, options, onChunk)
      default:
        throw new Error(`[DirectLLMClient] Unknown provider: "${profile.provider}"`)
    }
  }
}

// ─── createLLMClient factory ──────────────────────────────────────────────────

/**
 * Factory: reads orchestrator.yaml and returns the appropriate ILLMClient.
 *   litellm.enabled: true  → LiteLLMClient (opt-in sidecar)
 *   else                   → DirectLLMClient with active profiles from config
 *
 * @param yamlPath Optional override path to orchestrator.yaml (default: <cwd>/orchestrator.yaml)
 */
export function createLLMClient(yamlPath?: string): ILLMClient {
  if (process.env.NODE_ENV === 'test') {
    // In tests, the MockLLMClient is injected directly — never auto-create a DirectLLMClient.
    // This is a safeguard only; tests should never call createLLMClient().
    throw new Error('[createLLMClient] Do not call createLLMClient() in tests — inject MockLLMClient directly.')
  }

  const config = readOrchestratorConfig(yamlPath)

  if (config.litellm?.enabled) {
    // LiteLLM sidecar opt-in — dynamic import so the module is only required when enabled.
    // If the litellm-client module doesn't exist yet, fail loudly rather than silently.
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

  const activeIds = config.llm?.profiles_active ?? []
  const profiles  = loadActiveProfiles(activeIds)

  if (profiles.length === 0) {
    console.warn('[LLM] No active profiles found in orchestrator.yaml — using built-in defaults.')
  }

  return new DirectLLMClient(profiles.length > 0 ? profiles : undefined)
}
