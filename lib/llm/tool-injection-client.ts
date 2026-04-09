// lib/llm/tool-injection-client.ts
// ToolInjectionLLMClient — wraps any ILLMClient and pre-injects tools into every call.
// Unlike a plain { chat, stream } inline object, this class implements ILLMClient
// explicitly → TypeScript error immediately if the interface gains new methods.
//
// IMPORTANT — streaming + tools:
// The underlying streamAnthropic / streamOpenAI implementations do NOT implement a
// tool_use loop (streaming event formats differ per provider and tool loop is synchronous
// by nature). When this client is used in stream() the call is forwarded to chat() instead
// so the full tool loop runs correctly. onChunk is called once with the complete content
// when the response finishes. This means no token-by-token progress during tool use, but
// the SSE partial_output event still fires at the end with the complete content.

import type { ILLMClient, ChatMessage, ChatOptions, ChatResult, ToolDefinition } from './interface'

export class ToolInjectionLLMClient implements ILLMClient {
  constructor(
    private readonly inner:        ILLMClient,
    private readonly tools:        ToolDefinition[],
    private readonly toolExecutor: NonNullable<ChatOptions['toolExecutor']>,
  ) {}

  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    return this.inner.chat(messages, { ...options, tools: this.tools, toolExecutor: this.toolExecutor })
  }

  async stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult> {
    // The streaming implementations in the underlying LLM clients do not support
    // the tool_use loop — they silently ignore `tools` and `toolExecutor`.
    // Fall back to chat() (which has the full tool loop) and emit the complete
    // content via onChunk once finished so the SSE partial_output still fires.
    const result = await this.inner.chat(
      messages,
      { ...options, tools: this.tools, toolExecutor: this.toolExecutor },
    )
    if (result.model && onModelResolved) onModelResolved(result.model)
    if (result.content) onChunk(result.content)
    return result
  }
}

