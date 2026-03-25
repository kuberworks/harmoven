// lib/llm/mock-client.ts
// MockLLMClient — deterministic LLM stub for unit tests.
// Returns predefined responses instantly (no network, no cost, no latency).
//
// Usage in tests:
//   const llm = new MockLLMClient()
//   llm.setNextResponse('Custom content for n2')  // optional override
//   const result = await llm.chat([...], { model: 'mock' })

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface ChatResult {
  content: string
  tokensIn: number
  tokensOut: number
  model: string
}

/** ILLMClient — minimal client interface used by agents. */
export interface ILLMClient {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>
  stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
  ): Promise<ChatResult>
}

/** Default stub response for nodes that don't have a custom override. */
const DEFAULT_STUB = '{"status":"ok","content":"stub output"}'

/**
 * MockLLMClient — used in all unit tests.
 * Tracks call count and last messages for assertion in tests.
 */
export class MockLLMClient implements ILLMClient {
  /** Predefined response queue. First-in, first-out. Falls back to DEFAULT_STUB. */
  private responseQueue: string[] = []
  /** All calls recorded for assertion. */
  readonly calls: { messages: ChatMessage[]; options: ChatOptions }[] = []
  /** Optional per-call delay in ms (simulate LLM latency). Default: 0. */
  delayMs = 0

  /** Enqueue a response to be returned on the next chat/stream call. */
  setNextResponse(content: string): this {
    this.responseQueue.push(content)
    return this
  }

  /** Enqueue multiple responses (one per node). */
  setResponses(contents: string[]): this {
    this.responseQueue.push(...contents)
    return this
  }

  private dequeue(): string {
    return this.responseQueue.shift() ?? DEFAULT_STUB
  }

  private async maybeDelay(signal?: AbortSignal): Promise<void> {
    if (this.delayMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    this.calls.push({ messages, options })
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await this.maybeDelay(options.signal)
    const content = this.dequeue()
    return {
      content,
      tokensIn: Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4),
      tokensOut: Math.ceil(content.length / 4),
      model: options.model,
    }
  }

  async stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
  ): Promise<ChatResult> {
    this.calls.push({ messages, options })
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await this.maybeDelay(options.signal)
    const content = this.dequeue()
    // Emit as a single chunk (no real streaming in mock)
    onChunk(content)
    return {
      content,
      tokensIn: Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4),
      tokensOut: Math.ceil(content.length / 4),
      model: options.model,
    }
  }

  /** Reset call history and response queue. */
  reset(): this {
    this.calls.length = 0
    this.responseQueue.length = 0
    return this
  }
}
