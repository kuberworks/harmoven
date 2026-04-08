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

  // ── Tool_use / function_calling (Partie 1 §1.2) ──────────────────────────

  /**
   * List of tools available to the LLM for this call.
   * Absent/empty = current behaviour unchanged.
   */
  tools?: ToolDefinition[]

  /**
   * Callback invoked by DirectLLMClient each time the LLM makes tool_calls.
   * The return value is injected into the conversation before the next LLM call.
   *
   * CALLER RESPONSIBILITIES:
   * - Validate inputs before execution (never trust the LLM's JSON)
   * - Apply assertNotPrivateHost() on any URL
   * - Respect signal for cancellation
   * - Return ToolResult[] of same length as ToolCall[] (order preserved)
   * - Never throw — errors encapsulated in { is_error: true, content: msg }
   */
  toolExecutor?: (calls: ToolCall[], signal?: AbortSignal) => Promise<ToolResult[]>

  /**
   * Maximum number of tool_use loop iterations.
   * Default: 5. Hard cap applied by DirectLLMClient: 10.
   * Prevents infinite loops.
   */
  maxToolIterations?: number
}

export interface ChatResult {
  content: string
  tokensIn: number
  tokensOut: number
  model: string
  /** Estimated cost in USD computed from the profile's price-per-million-token rates. */
  costUsd: number
  /**
   * Trace of tool call iterations. Only present when ≥1 tool_call occurred.
   * Absent = no tools used (current behaviour preserved).
   */
  tool_calls_trace?: ToolCallIteration[]
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

// ── Tool_use types (Partie 1 §1.1) ──────────────────────────────────────────

export interface ToolDefinition {
  name: string            // ^[a-z][a-z0-9_]{0,63}$
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
  items?: ToolParameterSchema
  minimum?: number
  maximum?: number
}

export interface ToolCall {
  id:    string
  name:  string
  input: Record<string, unknown>
}

export interface ToolResult {
  tool_call_id: string
  content:      string
  is_error?:    boolean
}

export interface ToolCallIteration {
  iteration:    number
  tool_calls:   ToolCall[]
  tool_results: ToolResult[]
  tokens_in:    number
  tokens_out:   number
}

