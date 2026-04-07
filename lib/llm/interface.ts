// lib/llm/interface.ts
// ILLMClient — stable contract for all LLM client implementations.
// Import types from here, NOT from mock-client.ts.
//
// Implementations:
//   DirectLLMClient  → lib/llm/client.ts   (production)
//   MockLLMClient    → lib/llm/mock-client.ts (tests only)

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  model: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /**
   * Per-call multi-criteria selection context.
   * When set, DirectLLMClient uses selectLlm() instead of selectByTier() to
   * enforce confidentiality / jurisdiction / budget constraints.
   * Agents never set this directly — it is injected by ContextualLLMClient in runner.ts.
   */
  selectionContext?: {
    task_type?: string
    complexity?: 'low' | 'medium' | 'high'
    estimated_tokens?: number
    /** CRITICAL forces local-only; HIGH requires trust_tier ≤ 2. */
    confidentiality?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    jurisdictionTags?: string[]
    preferredLlmId?: string
    budgetRemaining?: number
  }
}

export interface ChatResult {
  content: string
  tokensIn: number
  tokensOut: number
  model: string
  /** Estimated cost in USD computed from the profile's price-per-million-token rates. */
  costUsd: number
}

/** ILLMClient — minimal client interface used by agents and the executor. */
export interface ILLMClient {
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>
  stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
    /** Fired as soon as the model is selected (before the first chunk). */
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult>
}
