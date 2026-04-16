// lib/llm/mock-client.ts
// MockLLMClient — deterministic LLM stub for unit tests.
// Returns predefined responses instantly (no network, no cost, no latency).
//
// Usage in tests:
//   const llm = new MockLLMClient()
//   llm.setNextResponse('Custom content for n2')  // optional override
//   const result = await llm.chat([...], { model: 'mock' })

// Re-export types from the canonical interface location so existing test
// imports (from '@/lib/llm/mock-client') continue to work without changes.
import type { ChatMessage, ChatOptions, ChatResult, ILLMClient, ToolCall } from '@/lib/llm/interface'
export type { ChatMessage, ChatOptions, ChatResult, ILLMClient } from '@/lib/llm/interface'

/** Default stub response for nodes that don't have a custom override. */
const DEFAULT_STUB = '{"status":"ok","content":"stub output"}'

/**
 * MockLLMClient — used in all unit tests.
 * Tracks call count and last messages for assertion in tests.
 */
export class MockLLMClient implements ILLMClient {
  /** Predefined response queue. First-in, first-out. Falls back to DEFAULT_STUB. */
  private responseQueue: string[] = []
  /**
   * Queue of tool_call sequences for simulating agentic loops.
   * Each entry = one iteration: { tool_calls to simulate, finalContent after execution }.
   */
  private toolCallQueue: Array<{ tool_calls: ToolCall[]; finalContent?: string }> = []
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

  /**
   * Enqueue a synthetic tool_call response for the next chat() call.
   * If toolExecutor is provided in ChatOptions, the mock will call it with
   * `tool_calls`, then return `finalContent` (or next responseQueue item) as
   * the final answer.
   */
  setNextToolCallResponse(tool_calls: ToolCall[], finalContent?: string): this {
    this.toolCallQueue.push({ tool_calls, finalContent })
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

    // Simulate one tool_call iteration if queued + toolExecutor is present
    if (this.toolCallQueue.length > 0 && options.toolExecutor) {
      const entry = this.toolCallQueue.shift()!
      const results = await options.toolExecutor(entry.tool_calls, options.signal)
      const content = entry.finalContent ?? this.responseQueue.shift() ?? DEFAULT_STUB
      return {
        content,
        tokensIn:  50,
        tokensOut: 50,
        model:     options.model,
        costUsd:   0,
        tool_calls_trace: [{
          iteration:    1,
          tool_calls:   entry.tool_calls,
          tool_results: results,
          tokens_in:    25,
          tokens_out:   25,
        }],
      }
    }

    const content = this.dequeue()
    return {
      content,
      tokensIn: Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4),
      tokensOut: Math.ceil(content.length / 4),
      model: options.model,
      costUsd: 0,
    }
  }

  async stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult> {
    this.calls.push({ messages, options })
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    await this.maybeDelay(options.signal)
    onModelResolved?.(options.model)
    const content = this.dequeue()
    // Emit as a single chunk (no real streaming in mock)
    onChunk(content)
    return {
      content,
      tokensIn: Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4),
      tokensOut: Math.ceil(content.length / 4),
      model: options.model,
      costUsd: 0,
    }
  }

  /** Reset call history and response queue. */
  reset(): this {
    this.calls.length = 0
    this.responseQueue.length = 0
    this.toolCallQueue.length = 0
    return this
  }
}

