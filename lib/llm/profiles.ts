// lib/llm/profiles.ts
// Built-in LLM profile catalog.
// Profiles are loaded from the `llm.profiles_active` list in orchestrator.yaml.
// Each entry in profiles_active must match an `id` in BUILT_IN_PROFILES.
//
// Profile fields mirror the Prisma LlmProfile model (TECHNICAL.md §3, §6).
// Provider routing: 'anthropic' | 'openai' | 'gemini' | 'cometapi' | 'ollama'
// Tier:            'fast' | 'balanced' | 'powerful'
// Trust tier:       1 = major cloud, audited SLA
//                   2 = major cloud, less strict SLA
//                   3 = CN jurisdiction or unvetted

export interface LlmProfileConfig {
  /** Unique identifier used in orchestrator.yaml profiles_active list. */
  id: string
  /** Provider used for routing: 'anthropic' | 'openai' | 'gemini' | 'cometapi' | 'ollama' */
  provider: string
  /** Exact model string sent to the provider API. */
  model_string: string
  /** Agent LLM tier requested by agents (classifier='fast', reviewer='powerful', etc.) */
  tier: 'fast' | 'balanced' | 'powerful'
  /** Maximum context window in tokens. */
  context_window: number
  /** USD per 1 M input tokens. */
  cost_per_1m_input_tokens: number
  /** USD per 1 M output tokens. */
  cost_per_1m_output_tokens: number
  /** Data jurisdiction: 'us' | 'eu' | 'cn' | 'local' */
  jurisdiction: 'us' | 'eu' | 'cn' | 'local'
  /** Trust tier 1–3. See TECHNICAL.md §6 Confidentiality × jurisdiction gate. */
  trust_tier: 1 | 2 | 3
  /** Task types this model is particularly strong at. */
  task_type_affinity: string[]
  /** Base URL override for OpenAI-compatible providers (CometAPI, Ollama). */
  base_url?: string
  /** Environment variable holding the API key for this provider. */
  api_key_env?: string
  /** Encrypted API key stored in DB (AES-256-GCM via encryptLlmKey). Takes priority over api_key_env. */
  api_key_enc?: string
  /** Hard cap on output tokens for this model (provider-specific limit). LLM client clamps max_tokens to this value. */
  max_output_tokens?: number
  /**
   * Whether this provider supports OpenAI-style tool_choice injection.
   * Defaults to true (absent = supported). Set to false for providers that
   * return empty choices when tools are injected (e.g. MiniMax, some Ollama models).
   * When false, the LLM client skips tool injection and relies on pre_search_context
   * embedded in the user message by runner.ts.
   */
  supports_tool_choice?: boolean
  /**
   * Extra HTTP headers to send on every request for this profile.
   * Used by OpenAI-compatible providers that require custom headers
   * (e.g. GitHub Models: X-GitHub-Api-Version).
   * Plugin providers handle their own headers internally — this field
   * is available for admin-configured custom/github profiles.
   */
  extra_headers?: Record<string, string>
  /**
   * When true, use `max_completion_tokens` instead of `max_tokens` in requests.
   * Required for OpenAI o-series and GPT-5.x models which dropped `max_tokens`.
   */
  uses_max_completion_tokens?: boolean
}

// ─── Built-in catalog ──────────────────────────────────────────────────────────

export const BUILT_IN_PROFILES: LlmProfileConfig[] = [

  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    // claude-haiku-4-5: fastest Claude 4 — fast tier (2025)
    id:                       'claude-haiku-4-5',
    provider:                 'anthropic',
    model_string:             'claude-haiku-4-5',
    tier:                     'fast',
    context_window:           200_000,
    cost_per_1m_input_tokens:  0.80,
    cost_per_1m_output_tokens: 4.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['intent_classification', 'context_distillation', 'simple_coding_tasks', 'high_volume_coding'],
    api_key_env:              'ANTHROPIC_API_KEY',
    max_output_tokens:        64_000,
  },
  {
    // claude-sonnet-4-6: balanced Claude 4 — PLANNER, WRITER (2025)
    id:                       'claude-sonnet-4-6',
    provider:                 'anthropic',
    model_string:             'claude-sonnet-4-6',
    tier:                     'balanced',
    context_window:           200_000,
    cost_per_1m_input_tokens:  3.00,
    cost_per_1m_output_tokens: 15.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['document_analysis', 'report_writing', 'marketing_content', 'hr_recruiting', 'research_synthesis'],
    api_key_env:              'ANTHROPIC_API_KEY',
  },
  {
    // claude-opus-4-6: most powerful Claude 4 — REVIEWER, complex reasoning (2025)
    id:                       'claude-opus-4-6',
    provider:                 'anthropic',
    model_string:             'claude-opus-4-6',
    tier:                     'powerful',
    context_window:           200_000,
    cost_per_1m_input_tokens:  15.00,
    cost_per_1m_output_tokens: 75.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['strategic_planning', 'legal_reasoning', 'ambiguity_resolution', 'complex_analysis'],
    api_key_env:              'ANTHROPIC_API_KEY',
  },
  {
    id:                       'claude-3-7-sonnet-20250219',
    provider:                 'anthropic',
    model_string:             'claude-3-7-sonnet-20250219',
    tier:                     'balanced',
    context_window:           200_000,
    cost_per_1m_input_tokens:  3.00,
    cost_per_1m_output_tokens: 15.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['document_analysis', 'report_writing'],
    api_key_env:              'ANTHROPIC_API_KEY',
  },
  {
    id:                       'claude-3-opus-20240229',
    provider:                 'anthropic',
    model_string:             'claude-3-opus-20240229',
    tier:                     'powerful',
    context_window:           200_000,
    cost_per_1m_input_tokens:  15.00,
    cost_per_1m_output_tokens: 75.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['strategic_planning', 'legal_reasoning'],
    api_key_env:              'ANTHROPIC_API_KEY',
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    id:                       'gpt-4o-mini',
    provider:                 'openai',
    model_string:             'gpt-5.4-nano',   // replaces gpt-4o-mini — https://developers.openai.com/api/docs/pricing
    tier:                     'fast',
    context_window:           128_000,
    cost_per_1m_input_tokens:  0.20,
    cost_per_1m_output_tokens: 1.25,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['intent_classification', 'simple_coding_tasks'],
    api_key_env:              'OPENAI_API_KEY',
    max_output_tokens:        128_000,   // OpenAI hard limit for completion tokens
    uses_max_completion_tokens: true,
  },
  {
    id:                       'gpt-4o',
    provider:                 'openai',
    model_string:             'gpt-5.4-mini',   // replaces gpt-4o — https://developers.openai.com/api/docs/pricing
    tier:                     'balanced',
    context_window:           128_000,
    cost_per_1m_input_tokens:  0.75,
    cost_per_1m_output_tokens: 4.50,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['document_analysis', 'report_writing', 'marketing_content'],
    api_key_env:              'OPENAI_API_KEY',
    max_output_tokens:        128_000,   // OpenAI hard limit for completion tokens
    uses_max_completion_tokens: true,
  },
  {
    id:                       'gpt-5-4',
    provider:                 'openai',
    model_string:             'gpt-5.4',   // GA as of 2026 — https://developers.openai.com/api/docs/pricing
    tier:                     'powerful',
    context_window:           128_000,
    cost_per_1m_input_tokens:  2.50,
    cost_per_1m_output_tokens: 15.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['strategic_planning', 'complex_analysis'],
    api_key_env:              'OPENAI_API_KEY',
    max_output_tokens:        128_000,   // OpenAI hard limit for completion tokens
    uses_max_completion_tokens: true,
  },

  // ── Google Gemini ──────────────────────────────────────────────────────────
  {
    id:                       'gemini-flash',
    provider:                 'gemini',
    model_string:             'gemini-1.5-flash',
    tier:                     'fast',
    context_window:           1_000_000,
    cost_per_1m_input_tokens:  0.075,
    cost_per_1m_output_tokens: 0.30,
    jurisdiction:             'us',
    trust_tier:               2,
    task_type_affinity:       ['long_context_analysis', 'intent_classification'],
    api_key_env:              'GOOGLE_API_KEY',
  },
  {
    id:                       'gemini-3-1-pro',
    provider:                 'gemini',
    model_string:             'gemini-1.5-pro',
    tier:                     'balanced',
    context_window:           2_000_000,
    cost_per_1m_input_tokens:  2.00,
    cost_per_1m_output_tokens: 8.00,
    jurisdiction:             'us',
    trust_tier:               2,
    task_type_affinity:       ['long_context_analysis', 'strategic_planning', 'research_synthesis'],
    api_key_env:              'GOOGLE_API_KEY',
  },

  // ── CometAPI — OpenAI-compatible gateway, 600+ models via single key ────────
  // Three tiers expose different model families through the same base_url + key.
  // Activate any combination in orchestrator.yaml → profiles_active.
  {
    id:                       'cometapi-fast',
    provider:                 'cometapi',
    model_string:             'gpt-4o-mini',  // fast + cheap — CLASSIFIER, simple tasks
    tier:                     'fast',
    context_window:           128_000,
    cost_per_1m_input_tokens:  0.15,
    cost_per_1m_output_tokens: 0.60,
    jurisdiction:             'us',
    trust_tier:               2,
    task_type_affinity:       ['intent_classification', 'simple_tasks'],
    base_url:                 'https://api.cometapi.com/v1',
    api_key_env:              'COMETAPI_API_KEY',
  },
  {
    id:                       'cometapi',         // kept for backward compatibility
    provider:                 'cometapi',
    model_string:             'gpt-4o',           // balanced — PLANNER, WRITER
    tier:                     'balanced',
    context_window:           128_000,
    cost_per_1m_input_tokens:  2.50,
    cost_per_1m_output_tokens: 10.00,
    jurisdiction:             'us',
    trust_tier:               2,
    task_type_affinity:       [],
    base_url:                 'https://api.cometapi.com/v1',
    api_key_env:              'COMETAPI_API_KEY',
  },
  {
    id:                       'cometapi-powerful',
    provider:                 'cometapi',
    model_string:             'claude-sonnet-4-6', // powerful — REVIEWER, complex reasoning
    tier:                     'powerful',
    context_window:           200_000,
    cost_per_1m_input_tokens:  3.00,
    cost_per_1m_output_tokens: 15.00,
    jurisdiction:             'us',
    trust_tier:               2,
    task_type_affinity:       ['complex_reasoning', 'review', 'planning'],
    base_url:                 'https://api.cometapi.com/v1',
    api_key_env:              'COMETAPI_API_KEY',
  },

  // ── Ollama — local OpenAI-compatible server ────────────────────────────────
  {
    id:                       'ollama_local',
    provider:                 'ollama',
    model_string:             'llama3.1:8b',   // default; overridden by detectOllama() results
    tier:                     'fast',
    context_window:           128_000,
    cost_per_1m_input_tokens:  0,
    cost_per_1m_output_tokens: 0,
    jurisdiction:             'local',
    trust_tier:               1,
    task_type_affinity:       ['intent_classification', 'simple_coding_tasks'],
    base_url:                 'http://localhost:11434/v1',
    api_key_env:              undefined,
    // Ollama models do not reliably support tool_choice — skip injection
    // and rely on pre_search_context for web-search nodes.
    supports_tool_choice:     false,
  },
]

// ─── DB ↔ LlmProfileConfig mapper ─────────────────────────────────────────────

/**
 * Map a Prisma LlmProfile row to the runtime LlmProfileConfig interface.
 * `base_url` and `api_key_env` are stored in the JSON `config` column
 * so they can be updated via the admin API without a schema migration.
 */
export function dbRowToLlmProfileConfig(row: {
  id:                        string
  provider:                  string
  model_string:              string
  tier:                      string
  context_window:            number
  cost_per_1m_input_tokens:  unknown  // Prisma Decimal → coerce
  cost_per_1m_output_tokens: unknown
  jurisdiction:              string
  trust_tier:                number
  task_type_affinity:        string[]
  config:                    unknown
}): LlmProfileConfig {
  const cfg = (typeof row.config === 'object' && row.config !== null
    ? row.config
    : {}) as Record<string, unknown>
  return {
    id:                       row.id,
    provider:                 row.provider,
    model_string:             row.model_string,
    tier:                     row.tier as LlmProfileConfig['tier'],
    context_window:           row.context_window,
    cost_per_1m_input_tokens:  Number(row.cost_per_1m_input_tokens),
    cost_per_1m_output_tokens: Number(row.cost_per_1m_output_tokens),
    jurisdiction:             row.jurisdiction as LlmProfileConfig['jurisdiction'],
    trust_tier:               row.trust_tier as LlmProfileConfig['trust_tier'],
    task_type_affinity:       row.task_type_affinity ?? [],
    base_url:          typeof cfg['base_url']          === 'string' ? cfg['base_url']          : undefined,
    api_key_env:       typeof cfg['api_key_env']       === 'string' ? cfg['api_key_env']       : undefined,
    api_key_enc:       typeof cfg['api_key_enc']       === 'string' ? cfg['api_key_enc']       : undefined,
    // Fall back to the built-in hard cap when the DB row predates the config
    // column that stores it — prevents Math.min(requestedTokens, Infinity) = requestedTokens
    // errors when the provider rejects the oversized limit (e.g. haiku 64k cap).
    max_output_tokens: typeof cfg['max_output_tokens'] === 'number'
      ? cfg['max_output_tokens']
      : BUILT_IN_PROFILES.find(p => p.id === row.id)?.max_output_tokens,
    // Admin can set supports_tool_choice: false in config JSON for providers that
    // return empty choices when tool_choice is injected (e.g. MiniMax via CometAPI).
    supports_tool_choice: typeof cfg['supports_tool_choice'] === 'boolean'
      ? cfg['supports_tool_choice']
      : BUILT_IN_PROFILES.find(p => p.id === row.id)?.supports_tool_choice,
    // Admin can set extra_headers in config JSON for OpenAI-compatible providers
    // that require custom request headers (e.g. X-GitHub-Api-Version).
    extra_headers: typeof cfg['extra_headers'] === 'object' && cfg['extra_headers'] !== null
      ? cfg['extra_headers'] as Record<string, string>
      : undefined,
    // Fall back to the built-in flag when the DB row was created before this field existed.
    uses_max_completion_tokens: typeof cfg['uses_max_completion_tokens'] === 'boolean'
      ? cfg['uses_max_completion_tokens']
      : BUILT_IN_PROFILES.find(p => p.id === row.id)?.uses_max_completion_tokens,
  }
}

// ─── Loader ────────────────────────────────────────────────────────────────────

/**
 * Priority-ordered list of fallback profile ids.
 * The first one whose api_key_env is defined in the environment is selected.
 * Ollama (no key required) is the last resort.
 */
const FALLBACK_PRIORITY = [
  'claude-haiku-4-5',   // ANTHROPIC_API_KEY
  'gpt-4o-mini',        // OPENAI_API_KEY
  'gemini-flash',       // GOOGLE_API_KEY
  'cometapi-fast',      // COMETAPI_API_KEY
  'ollama_local',       // no key required
]

/**
 * Return the id of the first built-in profile whose api_key_env is present
 * in the current environment. Falls back to 'ollama_local' if nothing is set.
 */
export function detectFallbackProfileId(): string {
  for (const id of FALLBACK_PRIORITY) {
    const profile = BUILT_IN_PROFILES.find(p => p.id === id)
    if (!profile) continue
    // Ollama has no api_key_env — always available as last resort
    if (!profile.api_key_env) return id
    if (process.env[profile.api_key_env]) return id
  }
  return 'ollama_local'
}

/**
 * Return the subset of BUILT_IN_PROFILES that are active per orchestrator.yaml.
 * Unknown IDs are warned and skipped.
 * If activeIds is empty, auto-detects the first available provider via env vars.
 */
export function loadActiveProfiles(activeIds: string[]): LlmProfileConfig[] {
  if (activeIds.length === 0) {
    const fallbackId = detectFallbackProfileId()
    const fallback = BUILT_IN_PROFILES.find(p => p.id === fallbackId)
    return fallback ? [fallback] : []
  }
  const result: LlmProfileConfig[] = []
  for (const id of activeIds) {
    const profile = BUILT_IN_PROFILES.find(p => p.id === id)
    if (profile) {
      result.push(profile)
    } else {
      console.warn(`[LLM] Unknown profile id in orchestrator.yaml profiles_active: "${id}" — skipping`)
    }
  }
  return result
}
