// app/api/admin/models/fetch/route.ts
// POST /api/admin/models/fetch
//
// Fetch the model list from an OpenAI-compatible endpoint.
// Used in two contexts:
//   1. Setup wizard — before the admin exists (public, userCount === 0).
//   2. Admin panel — instance_admin can probe a new provider's model list
//      before configuring it.
//
// Returns the list of model IDs so the caller can assign tiers and persist
// profiles via POST /api/admin/models.
//
// Security:
//   - Pre-setup (userCount === 0): open — no auth required.
//   - Post-setup: instance_admin required.
//   - base_url validated with validateLLMBaseUrl() — blocks SSRF / IMDS.
//   - api_key sanitised (max 256 chars), never logged or returned.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { validateLLMBaseUrl }        from '@/lib/security/ssrf-protection'
import { ValidationError }           from '@/lib/utils/input-validation'

const FetchModelsBody = z.object({
  base_url: z.string().max(512),
  api_key:  z.string().max(256).optional(),
}).strict()

export async function POST(req: NextRequest) {
  // ── Auth guard ──────────────────────────────────────────────────────────────
  // Pre-setup (no users yet): wizard calls this before any admin exists — allow.
  // Post-setup: require instance_admin.
  const userCount = await db.user.count()
  if (userCount > 0) {
    const caller = await resolveCaller(req)
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    try {
      assertInstanceAdmin(caller)
    } catch (e) {
      const status = e instanceof UnauthorizedError ? 401 : 403
      return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
    }
  }

  // ── Input validation ────────────────────────────────────────────────────────
  let body: unknown
  try { body = await req.json() } catch { body = {} }

  const parsed = FetchModelsBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { base_url, api_key } = parsed.data

  // ── SSRF guard ──────────────────────────────────────────────────────────────
  const normalised = base_url.trim().replace(/\/+$/, '')
  try {
    await validateLLMBaseUrl(normalised)
  } catch (err) {
    const msg = err instanceof ValidationError ? err.message : 'Invalid base URL'
    return NextResponse.json({ error: msg }, { status: 422 })
  }

  // ── Fetch model list ────────────────────────────────────────────────────────
  try {
    const res = await fetch(`${normalised}/models`, {
      headers: {
        'Authorization': api_key ? `Bearer ${api_key}` : 'Bearer no-key',
        'Content-Type':  'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      return NextResponse.json(
        { error: `Endpoint returned HTTP ${res.status}: ${text}` },
        { status: 400 },
      )
    }

    const data = await res.json() as unknown
    // OpenAI format: { data: [{ id: string, object: 'model' }, ...] }
    // Some providers return a plain array.
    const rawList = (data as { data?: unknown[] })?.data ?? (Array.isArray(data) ? data : [])
    const models: { id: string }[] = (rawList as Record<string, unknown>[])
      .filter(m => typeof m?.id === 'string')
      .map(m => ({ id: m.id as string }))
      .sort((a, b) => a.id.localeCompare(b.id))

    if (models.length === 0) {
      return NextResponse.json({ error: 'No models returned by this endpoint' }, { status: 400 })
    }

    return NextResponse.json({ ok: true, models, base_url: normalised })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Redact any embedded secrets from error messages (OpenAI sk-*, Gemini AIza*, HuggingFace hf_*, Replicate r8_*, AWS AKIA*, generic 40+ char tokens)
    const safe = msg
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
      .replace(/AIza[A-Za-z0-9_-]{30,}/g, '[REDACTED]')
      .replace(/hf_[a-zA-Z0-9]{20,}/g, '[REDACTED]')
      .replace(/r8_[a-zA-Z0-9]{20,}/g, '[REDACTED]')
      .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED]')
      .replace(/(?<![\w/])[a-zA-Z0-9+/]{40,}(?:={0,2})(?![\w/])/g, '[REDACTED]')
    return NextResponse.json({ error: `Failed to fetch models: ${safe}` }, { status: 400 })
  }
}
