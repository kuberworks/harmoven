// app/api/setup/llm-verify/route.ts
// POST /api/setup/llm-verify — Verify an LLM provider API key.
//
// Makes a minimal test call to the chosen provider to confirm the key is valid.
// Does NOT store the key — the admin must set the appropriate env var
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) before or after completing setup.
//
// Callable in two contexts:
//   1. During the first-run wizard (before any user exists, userCount === 0).
//   2. By an authenticated instance_admin after setup is complete (e.g. to verify
//      a changed key in Admin Settings).  The wizard calls this in Step 4 which
//      runs AFTER POST /api/setup/admin creates the admin in Step 2.
//
// Security:
//   - Pre-setup: public — no auth required (no admin exists yet).
//   - Post-setup: requires instance_admin session.
//   - api_key is sanitised (max 256 chars) and never logged or returned.
//   - Redacts both sk-* (OpenAI/Anthropic) and AIza* (Gemini) patterns from errors.
//   - ollama_url is validated with validateOllamaUrl() — blocks IMDS (169.254.x.x),
//     loopback, 0.0.0.0; allows RFC1918/LAN (legitimate on-prem Ollama deployments).
//   - Zod .strict() validation — no mass-assignment.

import { NextRequest, NextResponse } from 'next/server'
import { headers }                   from 'next/headers'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { auth }                      from '@/lib/auth'
import { validateOllamaUrl, validateLLMBaseUrl } from '@/lib/security/ssrf-protection'
import { ValidationError }           from '@/lib/utils/input-validation'
import { patchOrchestratorYaml }     from '@/lib/config-git/orchestrator-config'
import { BUILT_IN_PROFILES }         from '@/lib/llm/profiles'
import { encryptLlmKey }             from '@/lib/utils/llm-key-crypto'

// ─── Validation ────────────────────────────────────────────────────────────────

const VerifyBody = z.object({
  provider: z.enum(['anthropic', 'openai', 'gemini', 'ollama', 'litellm']),
  // api_key is optional for Ollama (no key needed) and litellm (endpoint may not require auth)
  api_key: z.string().max(256).optional(),
  // ollama_url overrides OLLAMA_BASE_URL env var for this verification call.
  // Validated server-side with validateOllamaUrl() — not stored.
  ollama_url: z.string().max(512).optional(),
  // litellm_url: base URL for OpenAI-compatible providers (SSRF-validated before use)
  litellm_url: z.string().max(512).optional(),
  // For litellm: user-assigned model → tier mappings — saved as LlmProfile rows
  models: z.array(z.object({
    id:   z.string().min(1).max(200),
    tier: z.enum(['fast', 'balanced', 'powerful']),
  })).max(50).optional(),
}).strict()

// ─── Per-provider verification ────────────────────────────────────────────────

/** Minimal test: list models (Anthropic) — pure metadata call, no tokens consumed. */
async function verifyAnthropic(apiKey: string): Promise<void> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  await client.models.list({ limit: 1 })
}

/** Minimal test: list models (OpenAI). */
async function verifyOpenAI(apiKey: string): Promise<void> {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey })
  await client.models.list()
}

/** Minimal test: generate 1 token (cheapest Gemini validation). */
async function verifyGemini(apiKey: string): Promise<void> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai')
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
  await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    generationConfig: { maxOutputTokens: 1 },
  })
}

/** Minimal test: call /models on an OpenAI-compatible endpoint. */
async function verifyLiteLLM(litellmUrl: string, apiKey?: string): Promise<void> {
  const base = litellmUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/models`, {
    headers: apiKey?.trim() ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Endpoint returned HTTP ${res.status}`)
}

/**
 * Minimal test: ping Ollama's /api/tags endpoint.
 *
 * URL resolution order:
 *   1. `ollamaUrl` from the request body (user-supplied, validated)
 *   2. `OLLAMA_BASE_URL` env var (operator-configured)
 *   3. `http://localhost:11434` fallback (same-host Ollama)
 */
async function verifyOllama(ollamaUrl?: string): Promise<void> {
  const base = (ollamaUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '')
  const res = await fetch(`${base}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status} from ${base}`)
}

// ─── Env var hint per provider ────────────────────────────────────────────────

const ENV_VAR_HINT: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai:    'OPENAI_API_KEY',
  gemini:    'GOOGLE_API_KEY',
  ollama:    '(no key needed)',
  litellm:   'LITELLM_API_KEY (set if needed)',
}

// ─── Provider → default profiles_active mapping ──────────────────────────────

const PROVIDER_PROFILES: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
  openai:    ['gpt-4o-mini', 'gpt-4o', 'gpt-5-4'],
  gemini:    ['gemini-flash', 'gemini-3-1-pro'],
  ollama:    ['ollama_local'],
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Auth guard — differs by setup state ─────────────────────────────────────
  // Pre-setup (no users yet): open to allow the wizard to run.
  // Post-setup: require an instance_admin session.
  const userCount = await db.user.count()
  if (userCount > 0) {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user || session.user.role !== 'instance_admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // ── Input validation ────────────────────────────────────────────────────────
  let body: unknown
  try { body = await req.json() } catch { body = {} }

  const parsed = VerifyBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { provider, api_key, ollama_url, litellm_url, models } = parsed.data

  // api_key is required for classic cloud providers (not Ollama or custom LiteLLM endpoints)
  if (provider !== 'ollama' && provider !== 'litellm' && !api_key?.trim()) {
    return NextResponse.json({ error: 'api_key is required for this provider' }, { status: 422 })
  }

  // litellm_url is required when provider is 'litellm'
  if (provider === 'litellm' && !litellm_url?.trim()) {
    return NextResponse.json({ error: 'litellm_url is required for this provider' }, { status: 422 })
  }

  // Validate the Ollama URL before any network call.
  // validateOllamaUrl() is synchronous and throws ValidationError on bad input.
  const resolvedOllamaUrl = ollama_url?.trim() || undefined
  if (resolvedOllamaUrl) {
    try {
      validateOllamaUrl(resolvedOllamaUrl)
    } catch (err) {
      const msg = err instanceof ValidationError ? err.message : 'Invalid Ollama URL'
      return NextResponse.json({ error: msg }, { status: 422 })
    }
  }

  // Validate the LiteLLM base URL (SSRF guard — blocks private hosts / IMDS).
  const resolvedLitellmUrl = litellm_url?.trim().replace(/\/+$/, '') || undefined
  if (provider === 'litellm' && resolvedLitellmUrl) {
    try {
      await validateLLMBaseUrl(resolvedLitellmUrl)
    } catch (err) {
      const msg = err instanceof ValidationError ? err.message : 'Invalid LiteLLM URL'
      return NextResponse.json({ error: msg }, { status: 422 })
    }
  }

  // ── Verify provider connection ──────────────────────────────────────────────
  try {
    const key = api_key?.trim() ?? ''
    switch (provider) {
      case 'anthropic': await verifyAnthropic(key);             break
      case 'openai':    await verifyOpenAI(key);                break
      case 'gemini':    await verifyGemini(key);                break
      case 'ollama':    await verifyOllama(resolvedOllamaUrl);                break
      case 'litellm':   await verifyLiteLLM(resolvedLitellmUrl!, api_key);  break
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Redact known API key formats from SDK error messages to prevent key leakage in logs/responses.
    // Covers: OpenAI/Anthropic (sk-*), Gemini (AIza*), xAI (xai-*),
    // Groq (gsk_*), Together (together-*), Mistral (any long alphanum after "mistral"),
    // Replicate (r8_*), Cohere (Co1z*), generic Bearer tokens.
    const safe = msg
      .replace(/sk-(?:ant-|proj-|or-v1-)?[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
      .replace(/AIza[A-Za-z0-9_-]{30,}/g, '[REDACTED]')
      .replace(/xai-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
      .replace(/gsk_[a-zA-Z0-9]{20,}/g, '[REDACTED]')
      .replace(/r8_[a-zA-Z0-9]{32,}/g, '[REDACTED]')
      .replace(/Co1z[A-Za-z0-9]{30,}/g, '[REDACTED]')
      .replace(/Bearer\s+[a-zA-Z0-9_\-.]{20,}/g, 'Bearer [REDACTED]')
    return NextResponse.json(
      { error: `Provider connection failed: ${safe}` },
      { status: 400 },
    )
  }

  // For Ollama, include the URL that was actually used so the user knows
  // which value to set in OLLAMA_BASE_URL.
  const effectiveOllamaUrl =
    provider === 'ollama'
      ? (resolvedOllamaUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434')
      : undefined

  // For litellm: save each assigned model as a LlmProfile row (upsert — idempotent).
  // Profile IDs are derived from the base URL slug + model ID for stability.
  if (provider === 'litellm' && resolvedLitellmUrl && models?.length) {
    const urlSlug = resolvedLitellmUrl
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
      .slice(0, 48)
    for (const m of models) {
      const profileId = `custom_${urlSlug}_${m.id}`.slice(0, 128)
      try {
        await db.llmProfile.upsert({
          where:  { id: profileId },
          update: {},
          create: {
            id:                        profileId,
            provider:                  'openai',
            model_string:              m.id,
            tier:                      m.tier,
            context_window:            8192,
            cost_per_1m_input_tokens:  0,
            cost_per_1m_output_tokens: 0,
            jurisdiction:              'local',
            trust_tier:                3,
            task_type_affinity:        [],
            enabled:                   true,
            config: {
              base_url: resolvedLitellmUrl,
              ...(api_key?.trim() ? { api_key_env: 'LITELLM_API_KEY' } : {}),
            },
          },
        })
      } catch (err) {
        console.warn(`[llm-verify] Failed to upsert profile "${profileId}" (non-fatal):`, err)
      }
    }
  }

  // Update orchestrator.yaml with the verified provider and its default profiles.
  // For litellm, custom profiles are already in the DB — only set default_provider.
  // Non-fatal — verification already succeeded; profile update is best-effort.
  try {
    if (provider === 'litellm') {
      await patchOrchestratorYaml(
        { llm: { default_provider: 'litellm' } },
        'setup:llm-verify',
      )
    } else {
      await patchOrchestratorYaml(
        { llm: { default_provider: provider as 'anthropic' | 'openai' | 'gemini' | 'ollama', profiles_active: PROVIDER_PROFILES[provider] ?? [] } },
        'setup:llm-verify',
      )
    }
  } catch (err) {
    console.warn('[llm-verify] Failed to update orchestrator.yaml (non-fatal):', err)
  }

  // Sync built-in profiles to DB immediately so Admin → Models reflects the
  // chosen provider right after the wizard step — without waiting for the first run.
  // Skipped for litellm (uses custom DB profiles created above, no built-in list).
  if (provider !== 'litellm') {
    const newActiveIds = PROVIDER_PROFILES[provider] ?? []
    const builtInIds   = BUILT_IN_PROFILES.map(p => p.id)

    // Encrypt the API key once for storage (if provided — Ollama has no key).
    // The encrypted value is written into config.api_key_enc of each seeded profile
    // so the app can call the provider without reading any env var at runtime.
    // The env var path (Option A) still works as a fallback when api_key_enc is absent.
    let encryptedKey: string | undefined
    if (api_key?.trim()) {
      try {
        encryptedKey = encryptLlmKey(api_key.trim())
      } catch {
        // ENCRYPTION_KEY not configured — skip DB storage, fall back to env var
        console.warn('[llm-verify] ENCRYPTION_KEY not set — API key will not be stored in DB')
      }
    }

    // 1. Seed (or re-enable) the new provider's profiles.
    for (const id of newActiveIds) {
      const built = BUILT_IN_PROFILES.find(p => p.id === id)
      if (!built) continue
      const profileConfig = {
        ...(built.base_url            ? { base_url:          built.base_url            } : {}),
        ...(built.api_key_env         ? { api_key_env:       built.api_key_env         } : {}),
        ...(built.max_output_tokens != null ? { max_output_tokens: built.max_output_tokens } : {}),
        ...(encryptedKey              ? { api_key_enc:       encryptedKey              } : {}),
      }
      try {
        await db.llmProfile.upsert({
          where:  { id },
          // Re-enable and sync model_string/pricing when the user re-runs the wizard
          // (e.g. rotating their API key or after a code update).
          update: {
            enabled:                   true,
            model_string:              built.model_string,
            cost_per_1m_input_tokens:  built.cost_per_1m_input_tokens,
            cost_per_1m_output_tokens: built.cost_per_1m_output_tokens,
            context_window:            built.context_window,
            ...(encryptedKey ? { config: profileConfig } : {}),
          },
          create: {
            id,
            provider:                  built.provider,
            model_string:              built.model_string,
            tier:                      built.tier,
            context_window:            built.context_window,
            cost_per_1m_input_tokens:  built.cost_per_1m_input_tokens,
            cost_per_1m_output_tokens: built.cost_per_1m_output_tokens,
            jurisdiction:              built.jurisdiction,
            trust_tier:                built.trust_tier,
            task_type_affinity:        built.task_type_affinity as string[],
            enabled:                   true,
            config:                    profileConfig,
          },
        })
      } catch (err) {
        console.warn(`[llm-verify] Failed to seed profile "${id}" (non-fatal):`, err)
      }
    }

    // 2. Disable built-in profiles that belong to other providers.
    //    This cleans up stale bootstrap profiles (e.g. ollama_local seeded on first boot).
    const toDisable = builtInIds.filter(id => !newActiveIds.includes(id))
    if (toDisable.length > 0) {
      try {
        await db.llmProfile.updateMany({
          where: { id: { in: toDisable }, enabled: true },
          data:  { enabled: false },
        })
      } catch (err) {
        console.warn('[llm-verify] Failed to disable stale built-in profiles (non-fatal):', err)
      }
    }
  }

  return NextResponse.json({
    ok:                true,
    provider,
    env_var_hint:      ENV_VAR_HINT[provider],
    effective_url:     effectiveOllamaUrl,
    message:
      provider === 'ollama'
        ? `Connection verified. Set OLLAMA_BASE_URL=${effectiveOllamaUrl} in your .env to persist this.`
        : provider === 'litellm'
          ? (api_key?.trim()
              ? 'Connection verified. Set LITELLM_API_KEY in your environment to persist this key.'
              : 'Connection verified. Endpoint is accessible without authentication.')
          : `Connection verified. Set ${ENV_VAR_HINT[provider]} in your environment to persist this key.`,
  })
}

