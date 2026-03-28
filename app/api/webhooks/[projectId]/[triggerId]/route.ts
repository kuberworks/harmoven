// app/api/webhooks/[projectId]/[triggerId]/route.ts
// POST /api/webhooks/:projectId/:triggerId — Inbound webhook trigger.
// Spec: openapi/v1.yaml /webhooks/{projectId}/{triggerId}.
//
// Security:
//   - HMAC-SHA256 signature validation (X-Hub-Signature-256: "sha256=<hex>")
//   - Timestamp freshness check (X-Webhook-Timestamp within ±5 min)
//   - Delivery idempotency via X-Webhook-Delivery UUID (WebhookDelivery table)
//   - No session/API key required — authentication is solely via HMAC
//   - Safety gate: max 20 auto-runs / $10 per day (instance-wide)

import { createHmac, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse }   from 'next/server'
import { db }                          from '@/lib/db/client'
import { uuidv7 }                      from '@/lib/utils/uuidv7'
import { getExecutionEngine }          from '@/lib/execution/engine.factory'

type Params = { params: Promise<{ projectId: string; triggerId: string }> }

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES    = 1 * 1024 * 1024   // 1 MB max payload
const TIMESTAMP_WINDOW  = 5 * 60             // 5 minutes in seconds
const DAILY_RUN_LIMIT   = 20                 // auto-runs per day (instance-wide)
const DAILY_COST_CAP_USD = 10               // $ per day (instance-wide)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * HMAC-SHA256 signature check.
 * Header format: "sha256=<64 hex chars>"
 */
function verifySignature(body: string, secret: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const actual   = signatureHeader.slice('sha256='.length)
  if (expected.length !== actual.length) return false
  // timingSafeEqual prevents timing oracle: compare as equal-length Buffers
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'))
}

/**
 * UTC midnight of the current day — used as the lower bound for rate-limit counters.
 */
function utcMidnight(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: Params) {
  const { projectId, triggerId } = await params

  // ── 1. Read raw body (needed for HMAC) ──────────────────────────────────────
  const rawBodyBuf = await req.arrayBuffer()
  if (rawBodyBuf.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const rawBody = Buffer.from(rawBodyBuf).toString('utf8')

  // ── 2. Look up trigger ───────────────────────────────────────────────────────
  const trigger = await db.trigger.findUnique({
    where: { id: triggerId },
    select: {
      id:         true,
      project_id: true,
      type:       true,
      enabled:    true,
      config:     true,
      supervision: true,
      task_overrides: true,
    },
  })

  // Return 404 for missing, wrong project, or disabled triggers — prevents enumeration
  if (!trigger || trigger.project_id !== projectId || !trigger.enabled || trigger.type !== 'WEBHOOK') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // ── 3. Validate HMAC-SHA256 ──────────────────────────────────────────────────
  const config = trigger.config as Record<string, unknown>
  const webhookSecret = typeof config['webhook_secret'] === 'string' ? config['webhook_secret'] : ''
  if (!webhookSecret) {
    // Trigger has no secret configured — reject for safety
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const signatureHeader = req.headers.get('x-hub-signature-256')
  if (!verifySignature(rawBody, webhookSecret, signatureHeader)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── 4. Timestamp freshness — REQUIRED (CVE-HARM-002: replay attack prevention) ────
  // The timestamp header is mandatory: without it an attacker who intercepts a valid
  // HMAC-signed payload can replay it indefinitely.
  // Senders must include X-Webhook-Timestamp: <unix seconds>; reject if absent.
  const timestampHeader = req.headers.get('x-webhook-timestamp')
  if (!timestampHeader) {
    return NextResponse.json({ error: 'X-Webhook-Timestamp header is required' }, { status: 400 })
  }
  const ts  = parseInt(timestampHeader, 10)
  const now = Math.floor(Date.now() / 1000)
  if (isNaN(ts) || Math.abs(now - ts) > TIMESTAMP_WINDOW) {
    return NextResponse.json({ error: 'Timestamp out of range — must be within ±5 minutes of server time' }, { status: 400 })
  }

  // ── 5. Idempotency — reject duplicate deliveries ─────────────────────────────
  const deliveryId = req.headers.get('x-webhook-delivery')
  if (deliveryId) {
    const existing = await db.webhookDelivery.findUnique({
      where: { delivery_id: deliveryId },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { message: 'Delivery already processed', run_id: null },
        { status: 409 },
      )
    }
  }

  // ── 6. Instance-wide safety gate (daily limits) ──────────────────────────────
  const dayStart = utcMidnight()

  // Count auto-runs created today (type = webhook trigger)
  const [todayRunCount, todayCostRows] = await Promise.all([
    db.run.count({
      where: {
        trigger_id: { not: null },
        created_at: { gte: dayStart },
      },
    }),
    db.run.aggregate({
      _sum: { cost_actual_usd: true },
      where: {
        trigger_id: { not: null },
        created_at: { gte: dayStart },
      },
    }),
  ])

  if (todayRunCount >= DAILY_RUN_LIMIT) {
    return NextResponse.json(
      { error: 'Daily auto-run limit reached (20/day). Resets at UTC midnight.' },
      { status: 429 },
    )
  }
  const todayCost = Number(todayCostRows._sum.cost_actual_usd ?? 0)
  if (todayCost >= DAILY_COST_CAP_USD) {
    return NextResponse.json(
      { error: 'Daily cost cap reached ($10/day). Resets at UTC midnight.' },
      { status: 429 },
    )
  }

  // ── 7. Parse payload + resolve task overrides ─────────────────────────────────
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    // Non-JSON payload is fine — treat as raw webhook event
    payload = { raw: rawBody.slice(0, 1000) }
  }

  const overrides = (trigger.task_overrides ?? {}) as Record<string, unknown>
  const taskInput = {
    objective: overrides['objective'] ?? `Webhook triggered by ${trigger.id}`,
    context:   JSON.stringify({ webhook_payload: payload }).slice(0, 5000),
    ...(overrides['task_input'] as Record<string, unknown> ?? {}),
  }

  // ── 8. Create run ─────────────────────────────────────────────────────────────
  const runId = uuidv7()
  const run = await db.run.create({
    data: {
      id:               runId,
      project_id:       projectId,
      trigger_id:       triggerId,
      created_by:       null,             // no user — auto-triggered
      status:           'PENDING',
      domain_profile:   (overrides['domain_profile'] as string) ?? 'generic',
      task_input:       taskInput,
      dag:              { nodes: [], edges: [] },
      run_config: {
        supervision_mode: trigger.supervision ?? 'auto_deliver_if_approved',
        providers: [],
      },
      transparency_mode: false,
      user_injections:  [],
      metadata:         { webhook_trigger_id: triggerId, delivery_id: deliveryId ?? null },
      task_input_chars: JSON.stringify(taskInput).length,
    },
  })

  // ── 9. Record delivery ID for idempotency ─────────────────────────────────────
  if (deliveryId) {
    await db.webhookDelivery.create({
      data: {
        delivery_id: deliveryId,
        trigger_id:  triggerId,
      },
    })
  }

  // ── 10. Update trigger stats ──────────────────────────────────────────────────
  await db.trigger.update({
    where: { id: triggerId },
    data: {
      last_fired_at: new Date(),
      run_count:     { increment: 1 },
    },
  })

  // ── 11. Audit log ─────────────────────────────────────────────────────────────
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       `webhook:${triggerId}`,
      action_type: 'run.created',
      run_id:      run.id,
      payload: {
        trigger_id:  triggerId,
        project_id:  projectId,
        delivery_id: deliveryId,
      },
    },
  })

  // ── 12. Enqueue (fire-and-forget) ────────────────────────────────────────────
  void getExecutionEngine().then(e => e.executeRun(run.id))

  return NextResponse.json(
    { run_id: run.id, message: 'Webhook accepted — run queued' },
    { status: 202 },
  )
}
