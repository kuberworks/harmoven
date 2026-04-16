// lib/llm/litellm-client.ts
// LiteLLMClient — ILLMClient implementation backed by a LiteLLM sidecar proxy.
// Spec: TECHNICAL.md §21 (opt-in sidecar), orchestrator.yaml litellm.enabled.
//
// LiteLLM exposes an OpenAI-compatible HTTP API on the configured address.
// SSRF guard: address is validated lazily before the first real network call.

import OpenAI from 'openai'
import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from '@/lib/llm/interface'
import { validateLLMBaseUrl } from '@/lib/security/ssrf-protection'
import { runOpenAIToolLoop } from '@/lib/llm/client'

export class LiteLLMClient implements ILLMClient {
  readonly name = 'litellm'
  private readonly address: string
  private client: OpenAI | null = null
  private validated = false

  /**
   * @param address  The base URL of the LiteLLM proxy, e.g. http://localhost:4000
   *                 SSRF-validated before the first actual HTTP request.
   */
  constructor(address: string) {
    this.address = address
  }

  /** Lazily validate + build the OpenAI-compat client on first call. */
  private async getClient(): Promise<OpenAI> {
    if (!this.validated) {
      await validateLLMBaseUrl(this.address)
      this.validated = true
    }
    if (!this.client) {
      this.client = new OpenAI({
        apiKey:  process.env.LITELLM_API_KEY ?? 'no-key',
        baseURL: this.address,
      })
    }
    return this.client
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const client = await this.getClient()

    // If tools present, use the shared OpenAI-compatible agentic loop
    if (options.tools?.length && options.toolExecutor) {
      return runOpenAIToolLoop(
        client,
        { model_string: options.model },
        messages.map(m => ({ role: m.role, content: m.content })),
        options,
        options.signal,
      )
    }

    // Use .withResponse() to access the x-litellm-cost HTTP response header.
    // LiteLLM proxies track per-call cost server-side and return it in this header.
    // Falls back to 0 if the header is absent (e.g. LiteLLM not configured with pricing).
    const { data: completion, response } = await client.chat.completions.create(
      {
        model:      options.model,
        max_tokens: options.maxTokens ?? 4096,
        messages:   messages.map(m => ({ role: m.role, content: m.content })),
      },
      { signal: options.signal },
    ).withResponse()

    const costUsd  = Number(response.headers.get('x-litellm-cost') ?? '0') || 0
    const content  = completion.choices?.[0]?.message?.content ?? ''
    return {
      content,
      tokensIn:  completion.usage?.prompt_tokens     ?? 0,
      tokensOut: completion.usage?.completion_tokens ?? 0,
      model:     completion.model,
      costUsd,
    }
  }

  async stream(
    messages: ChatMessage[],
    options:  ChatOptions,
    onChunk:  (chunk: string) => void,
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    // Fire early with the requested model; updated below if the server returns a different name.
    onModelResolved?.(options.model)
    const client = await this.getClient()

    // Use create({ stream: true }).withResponse() so we can read the x-litellm-cost
    // response header (sent with the opening HTTP frame, before any chunks).
    // stream_options.include_usage ensures the final chunk contains token counts.
    const { data: stream, response } = await client.chat.completions.create(
      {
        model:          options.model,
        max_tokens:     options.maxTokens ?? 4096,
        messages:       messages.map(m => ({ role: m.role, content: m.content })),
        stream:         true,
        stream_options: { include_usage: true },
      },
      { signal: options.signal },
    ).withResponse()

    const costUsd  = Number(response.headers.get('x-litellm-cost') ?? '0') || 0
    let fullText   = ''
    let modelName  = options.model
    let tokensIn   = 0
    let tokensOut  = 0

    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content ?? ''
      if (text) { onChunk(text); fullText += text }
      if (chunk.model) modelName = chunk.model
      // stream_options.include_usage → last chunk carries usage
      if (chunk.usage) {
        tokensIn  = chunk.usage.prompt_tokens     ?? 0
        tokensOut = chunk.usage.completion_tokens ?? 0
      }
    }

    return {
      content:   fullText,
      tokensIn,
      tokensOut,
      model:     modelName,
      costUsd,
    }
  }
}
