// lib/llm/litellm-client.ts
// LiteLLMClient — ILLMClient implementation backed by a LiteLLM sidecar proxy.
// Spec: TECHNICAL.md §21 (opt-in sidecar), orchestrator.yaml litellm.enabled.
//
// LiteLLM exposes an OpenAI-compatible HTTP API on the configured address.
// SSRF guard: address is validated lazily before the first real network call.

import OpenAI from 'openai'
import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from '@/lib/llm/interface'
import { validateLLMBaseUrl } from '@/lib/security/ssrf-protection'

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

    const completion = await client.chat.completions.create(
      {
        model:      options.model,
        max_tokens: options.maxTokens ?? 4096,
        messages:   messages.map(m => ({ role: m.role, content: m.content })),
      },
      { signal: options.signal },
    )

    const content = completion.choices[0]?.message?.content ?? ''
    return {
      content,
      tokensIn:  completion.usage?.prompt_tokens     ?? 0,
      tokensOut: completion.usage?.completion_tokens ?? 0,
      model:     completion.model,
      costUsd:   0,
    }
  }

  async stream(
    messages: ChatMessage[],
    options:  ChatOptions,
    onChunk:  (chunk: string) => void,
  ): Promise<ChatResult> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const client = await this.getClient()

    const stream = await client.chat.completions.stream(
      {
        model:      options.model,
        max_tokens: options.maxTokens ?? 4096,
        messages:   messages.map(m => ({ role: m.role, content: m.content })),
        stream:     true,
      },
      { signal: options.signal },
    )

    let fullText  = ''
    let modelName = options.model
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
      costUsd:   0,
    }
  }
}
