// app/api/admin/marketplace/smart-import-settings/route.ts
// GET  → read all marketplace.smart_import.* SystemSettings + budget snapshot
// PATCH → upsert changed settings (batch)

import { NextResponse }      from 'next/server'
import { headers }           from 'next/headers'
import { z }                 from 'zod'
import { auth }              from '@/lib/auth'
import { db }                from '@/lib/db/client'

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

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = (session.user as Record<string, unknown>).role as string | null
  if (role !== 'instance_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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

export async function PATCH(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const role = (session.user as Record<string, unknown>).role as string | null
  if (role !== 'instance_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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
