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
}

// ─── Built-in catalog ──────────────────────────────────────────────────────────

export const BUILT_IN_PROFILES: LlmProfileConfig[] = [

  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    id:                       'claude-haiku-4-5-20251001',
    provider:                 'anthropic',
    model_string:             'claude-haiku-4-5-20251001',
    tier:                     'fast',
    context_window:           200_000,
    cost_per_1m_input_tokens:  0.80,
    cost_per_1m_output_tokens: 4.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['intent_classification', 'context_distillation', 'simple_coding_tasks', 'high_volume_coding'],
    api_key_env:              'ANTHROPIC_API_KEY',
  },
  {
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

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    id:                       'gpt-4o-mini',
    provider:                 'openai',
    model_string:             'gpt-4o-mini',
    tier:                     'fast',
    context_window:           128_000,
    cost_per_1m_input_tokens:  0.15,
    cost_per_1m_output_tokens: 0.60,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['intent_classification', 'simple_coding_tasks'],
    api_key_env:              'OPENAI_API_KEY',
  },
  {
    id:                       'gpt-4o',
    provider:                 'openai',
    model_string:             'gpt-4o',
    tier:                     'balanced',
    context_window:           128_000,
    cost_per_1m_input_tokens:  2.50,
    cost_per_1m_output_tokens: 10.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['document_analysis', 'report_writing', 'marketing_content'],
    api_key_env:              'OPENAI_API_KEY',
  },
  {
    id:                       'gpt-5-4',
    provider:                 'openai',
    model_string:             'gpt-4o',    // conservative alias until gpt-5-4 GA
    tier:                     'powerful',
    context_window:           128_000,
    cost_per_1m_input_tokens:  5.00,
    cost_per_1m_output_tokens: 15.00,
    jurisdiction:             'us',
    trust_tier:               1,
    task_type_affinity:       ['strategic_planning', 'complex_analysis'],
    api_key_env:              'OPENAI_API_KEY',
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

  // ── CometAPI — OpenAI-compatible, 500+ models via single key ──────────────
  {
    id:                       'cometapi',
    provider:                 'cometapi',
    model_string:             'gpt-4o',    // default; overridden per-request if needed
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
  },
]

// ─── Loader ────────────────────────────────────────────────────────────────────

/**
 * Return the subset of BUILT_IN_PROFILES that are active per orchestrator.yaml.
 * Unknown IDs are warned and skipped.
 * If activeIds is empty, falls back to claude-haiku (minimum viable config).
 */
export function loadActiveProfiles(activeIds: string[]): LlmProfileConfig[] {
  if (activeIds.length === 0) {
    const fallback = BUILT_IN_PROFILES.find(p => p.id === 'claude-haiku-4-5-20251001')
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
