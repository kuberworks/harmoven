// app/api/admin/models/route.ts
// Admin LLM model management — list + create
//
// GET  /api/admin/models          — list all LlmProfile rows (optional ?enabled filter)
// POST /api/admin/models          — create a new LlmProfile
//
// Required: instance_admin role (instance-level resource, not project-scoped).
// Security: all body inputs validated with Zod strict mode.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { Prisma }                    from '@prisma/client'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller }        from '@/lib/auth/rbac'

// ─── Auth helper ──────────────────────────────────────────────────────────────

type AdminGuardResult =
  | { caller: SessionCaller; err: null }
  | { caller: null;          err: NextResponse }

async function guardAdminModels(req: NextRequest): Promise<AdminGuardResult> {
  const caller = await resolveCaller(req)
  if (!caller) {
    return { caller: null, err: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  try {
    assertInstanceAdmin(caller)
    return { caller, err: null }
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return { caller: null, err: NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status }) }
  }
}

// ─── GET /api/admin/models ───────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { err } = await guardAdminModels(req)
  if (err) return err

  const url     = new URL(req.url)
  const enabled = url.searchParams.get('enabled')

  const where =
    enabled === 'true'  ? { enabled: true }  :
    enabled === 'false' ? { enabled: false } :
    {}

  const models = await db.llmProfile.findMany({ where, orderBy: { id: 'asc' } })

  return NextResponse.json({ models })
}

// ─── POST /api/admin/models ──────────────────────────────────────────────────

const CreateModelBody = z.object({
  id:                        z.string().min(1).max(128),
  provider:                  z.string().min(1).max(64),
  model_string:              z.string().min(1).max(256),
  tier:                      z.string().min(1).max(64),
  jurisdiction:              z.string().max(32),
  trust_tier:                z.number().int().min(1).max(3),
  context_window:            z.number().int().positive(),
  cost_per_1m_input_tokens:  z.number().nonnegative(),
  cost_per_1m_output_tokens: z.number().nonnegative(),
  task_type_affinity:        z.array(z.string()).optional().default([]),
  enabled:                   z.boolean().optional().default(true),
  config:                    z.record(z.unknown()).optional(),
}).strict()

export async function POST(req: NextRequest) {
  const { err } = await guardAdminModels(req)
  if (err) return err

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = CreateModelBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const {
    id, provider, model_string, tier, jurisdiction, trust_tier,
    context_window, cost_per_1m_input_tokens, cost_per_1m_output_tokens,
    task_type_affinity, enabled, config,
  } = parsed.data

  // Detect duplicate
  const existing = await db.llmProfile.findUnique({ where: { id } })
  if (existing) {
    return NextResponse.json({ error: 'Model ID already exists' }, { status: 409 })
  }

  const model = await db.llmProfile.create({
    data: {
      id,
      provider,
      model_string,
      tier,
      jurisdiction,
      trust_tier,
      context_window,
      cost_per_1m_input_tokens,
      cost_per_1m_output_tokens,
      task_type_affinity:        task_type_affinity ?? [],
      enabled:                   enabled ?? true,
      ...(config !== undefined && { config: config as Prisma.InputJsonValue }),
    },
  })

  return NextResponse.json({ model }, { status: 201 })
}
