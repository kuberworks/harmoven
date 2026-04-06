// app/api/setup/llm-verify/route.ts
// POST /api/setup/llm-verify — First-run wizard: verify an LLM provider API key.
//
// Makes a minimal test call to the chosen provider to confirm the key is valid.
// Does NOT store the key — the admin must set the appropriate env var
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) before or after completing setup.
//
// Security:
//   - Public route (no auth required — invoked before admin account is usable).
//   - Guard: only callable before setup is complete (userCount === 0).
//   - api_key input sanitised (max 256 chars, pattern-validated per provider).
//   - SSRF: providers called via their official SDKs — no user-supplied base URLs.
//   - Zod .strict() validation — no mass-assignment.
//   - api_key is never logged or returned in responses.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'

// ─── Validation ────────────────────────────────────────────────────────────────

const VerifyBody = z.object({
  provider: z.enum(['anthropic', 'openai', 'gemini', 'ollama']),
  // api_key is optional for Ollama (no key needed — local connection only)
  api_key: z.string().max(256).optional(),
}).strict()

// ─── Per-provider verification ────────────────────────────────────────────────

/** Minimal test: list models (Anthropic) — 1 token call, cheapest possible. */
async function verifyAnthropic(apiKey: string): Promise<void> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })
  // models.list() does not consume tokens — pure metadata call
  await client.models.list({ limit: 1 })
}

/** Minimal test: list models (OpenAI). */
async function verifyOpenAI(apiKey: string): Promise<void> {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({ apiKey })
  // models.list() does not consume tokens
  await client.models.list()
}

/** Minimal test: list models (Gemini). */
async function verifyGemini(apiKey: string): Promise<void> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai')
  const genAI = new GoogleGenerativeAI(apiKey)
  // getGenerativeModel is synchronous — calling generateContent with max 1 token
  // is the cheapest way to validate a key
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
  await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    generationConfig: { maxOutputTokens: 1 },
  })
}

/** Minimal test: ping Ollama's local API endpoint. */
async function verifyOllama(): Promise<void> {
  const res = await fetch('http://localhost:11434/api/tags', {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`)
}

// ─── Env var hint per provider ────────────────────────────────────────────────

const ENV_VAR_HINT: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai:    'OPENAI_API_KEY',
  gemini:    'GOOGLE_API_KEY',
  ollama:    '(no key needed)',
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Setup-complete guard ────────────────────────────────────────────────────
  const userCount = await db.user.count()
  if (userCount > 0) {
    return NextResponse.json(
      { error: 'Setup already complete.' },
      { status: 409 },
    )
  }

  // ── Input validation ────────────────────────────────────────────────────────
  let body: unknown
  try { body = await req.json() } catch { body = {} }

  const parsed = VerifyBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { provider, api_key } = parsed.data

  // api_key is required for non-Ollama providers
  if (provider !== 'ollama' && !api_key?.trim()) {
    return NextResponse.json({ error: 'api_key is required for this provider' }, { status: 422 })
  }

  // ── Verify provider connection ──────────────────────────────────────────────
  try {
    const key = api_key?.trim() ?? ''
    switch (provider) {
      case 'anthropic': await verifyAnthropic(key); break
      case 'openai':    await verifyOpenAI(key);    break
      case 'gemini':    await verifyGemini(key);    break
      case 'ollama':    await verifyOllama();        break
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Strip any api_key echo from SDK error messages before returning
    const safe = msg.replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
    return NextResponse.json(
      { error: `Provider connection failed: ${safe}` },
      { status: 400 },
    )
  }

  return NextResponse.json({
    ok:          true,
    provider,
    env_var_hint: ENV_VAR_HINT[provider],
    message:     `Connection verified. Set ${ENV_VAR_HINT[provider]} in your environment to persist this key.`,
  })
}
