// lib/llm/tool-injection-client.ts
// ToolInjectionLLMClient — wraps any ILLMClient and pre-injects tools into every call.
// Unlike a plain { chat, stream } inline object, this class implements ILLMClient
// explicitly → TypeScript error immediately if the interface gains new methods.

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
