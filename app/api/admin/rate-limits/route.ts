// app/api/admin/rate-limits/route.ts
// Admin endpoint — read and update configurable rate-limit settings.
//
// GET  /api/admin/rate-limits
//   Returns all configurable endpoints with current effective values + defaults.
//
// PATCH /api/admin/rate-limits
//   Upserts one or more endpoint settings.
//   Body: { limits: { <endpoint>: { max?: number; window_ms?: number } } }
//   Constraints: max >= 1, window_ms >= 1000 (1 second).
//
// Required: instance_admin.
// Changes take effect within 60 seconds (cache TTL).

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { db }                        from '@/lib/db/client'
import {
  RATE_LIMIT_DEFAULTS,
  getAllRateLimitConfigs,
  invalidateRateLimitCache,
  type RateLimitEndpoint,
} from '@/lib/auth/rate-limit-config'

// ─── Auth guard ───────────────────────────────────────────────────────────────

async function guardAdmin(req: NextRequest): Promise<NextResponse | null> {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    assertInstanceAdmin(caller)
    return null
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authErr = await guardAdmin(req)
  if (authErr) return authErr

  const limits = await getAllRateLimitConfigs()
  return NextResponse.json({ limits })
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

const EndpointPatchSchema = z.object({
  max:       z.number().int().min(1).optional(),
  window_ms: z.number().int().min(1000).optional(),
})

const PatchBody = z.object({
  limits: z.record(
    z.enum(['signin', 'create-run', 'create-api-key', 'webhook', 'admin-cred-create'] as const),
    EndpointPatchSchema,
  ).refine(v => Object.keys(v).length > 0, { message: 'limits must have at least one entry' }),
}).strict()

export async function PATCH(req: NextRequest) {
  const authErr = await guardAdmin(req)
  if (authErr) return authErr

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = PatchBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const upserts: { key: string; value: string }[] = []
  for (const endpoint of Object.keys(parsed.data.limits) as RateLimitEndpoint[]) {
    const patch = parsed.data.limits[endpoint]
    if (!patch) continue
    if (patch.max !== undefined) {
      upserts.push({ key: `rate_limit.${endpoint}.max`, value: String(patch.max) })
    }
    if (patch.window_ms !== undefined) {
      upserts.push({ key: `rate_limit.${endpoint}.window_ms`, value: String(patch.window_ms) })
    }
  }

  if (upserts.length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 422 })
  }

  await db.$transaction(
    upserts.map(({ key, value }) =>
      db.systemSetting.upsert({
        where:  { key },
        update: { value },
        create: { key, value },
      }),
    ),
  )

  // Invalidate in-process cache so the next request reads the new values
  invalidateRateLimitCache()

  const limits = await getAllRateLimitConfigs()
  return NextResponse.json({ limits })
}
