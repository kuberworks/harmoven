// app/api/admin/marketplace/smart-import-settings/route.ts
// GET  → read all marketplace.smart_import.* SystemSettings + budget snapshot
// PATCH → upsert changed settings (batch)

import { NextRequest, NextResponse }  from 'next/server'
import { z }                          from 'zod'
import { db }                         from '@/lib/db/client'
import { resolveCaller }              from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const KEYS = [
  'marketplace.smart_import.enabled',
  'marketplace.smart_import.provider_id',
  'marketplace.smart_import.model',
  'marketplace.smart_import.max_tokens',
  'marketplace.smart_import.preview_ttl_hours',
  'marketplace.smart_import.monthly_budget_usd',
] as const

const PatchSchema = z.object({
  settings: z.record(z.string(), z.string().nullable()),
})

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function guardAdmin(req: NextRequest): Promise<NextResponse | null> {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
  return null
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authErr = await guardAdmin(req)
  if (authErr) return authErr

  const rows = await db.systemSetting.findMany({ where: { key: { in: [...KEYS] } } })
  const map: Record<string, string> = {}
  for (const row of rows) {
    map[row.key] = row.value as string
  }

  return NextResponse.json({
    enabled:             map['marketplace.smart_import.enabled'] !== 'false',
    provider_id:         map['marketplace.smart_import.provider_id'] ?? null,
    model:               map['marketplace.smart_import.model'] ?? null,
    max_tokens:          parseInt(map['marketplace.smart_import.max_tokens'] ?? '4000', 10),
    preview_ttl_hours:   parseInt(map['marketplace.smart_import.preview_ttl_hours'] ?? '24', 10),
    monthly_budget_usd:  map['marketplace.smart_import.monthly_budget_usd']
      ? parseFloat(map['marketplace.smart_import.monthly_budget_usd'])
      : null,
  })
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  const authErr = await guardAdmin(req)
  if (authErr) return authErr

  // M-5 fix: wrap req.json() in try/catch — malformed JSON must return 400, not 500.
  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { settings } = parsed.data

  // Only allow known keys (deny-list of arbitrary key injection)
  const allowedKeys = new Set(KEYS as readonly string[])
  const invalidKeys = Object.keys(settings).filter((k) => !allowedKeys.has(k))
  if (invalidKeys.length > 0) {
    return NextResponse.json({ error: `Unknown settings keys: ${invalidKeys.join(', ')}` }, { status: 400 })
  }

  await db.$transaction(
    Object.entries(settings).map(([key, value]) =>
      value === null
        ? db.systemSetting.deleteMany({ where: { key } })
        : db.systemSetting.upsert({
            where:  { key },
            update: { value },
            create: { key, value },
          })
    )
  )

  return NextResponse.json({ ok: true })
}
