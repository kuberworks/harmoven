// app/api/admin/triggers/route.ts
// Admin trigger management — list + create
//
// GET  /api/admin/triggers          — list all triggers (optional ?project_id= filter)
// POST /api/admin/triggers          — create a new trigger
//
// Required: instance_admin role (triggers are instance-level).
// Security: Zod strict body validation.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { Prisma }                    from '@prisma/client'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller }        from '@/lib/auth/rbac'

// ─── Auth helper ──────────────────────────────────────────────────────────────

type AdminGuardResult =
  | { caller: SessionCaller; err: null }
  | { caller: null;          err: NextResponse }

async function guardAdminTriggers(req: NextRequest): Promise<AdminGuardResult> {
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

// ─── GET /api/admin/triggers ──────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { err } = await guardAdminTriggers(req)
  if (err) return err

  const url       = new URL(req.url)
  const projectId = url.searchParams.get('project_id') ?? undefined
  const enabled   = url.searchParams.get('enabled')

  const where: Record<string, unknown> = {}
  if (projectId) where['project_id'] = projectId
  if (enabled === 'true')  where['enabled'] = true
  if (enabled === 'false') where['enabled'] = false

  const triggers = await db.trigger.findMany({
    where,
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json({ triggers })
}

// ─── POST /api/admin/triggers ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CreateTriggerBody = z.object({
  project_id:     z.string().regex(UUID_RE, 'project_id must be a UUID'),
  type:           z.enum(['CRON', 'FILE_WATCHER', 'WEBHOOK']),
  name:           z.string().min(1).max(128),
  config:         z.record(z.unknown()),
  template_id:    z.string().regex(UUID_RE).optional(),
  task_overrides: z.record(z.unknown()).optional(),
  supervision:    z.string().max(64).optional(),
  notify:         z.record(z.unknown()).optional(),
  enabled:        z.boolean().optional().default(true),
}).strict()

export async function POST(req: NextRequest) {
  const { caller, err } = await guardAdminTriggers(req)
  if (err) return err

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = CreateTriggerBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const {
    project_id, type, name, config,
    template_id, task_overrides, supervision, notify, enabled,
  } = parsed.data

  // Verify project exists
  const project = await db.project.findUnique({ where: { id: project_id }, select: { id: true } })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const trigger = await db.trigger.create({
    data: {
      project_id,
      type,
      name,
      config:                      config as Prisma.InputJsonValue,
      ...(template_id    !== undefined && { template_id }),
      ...(task_overrides !== undefined && { task_overrides: task_overrides as Prisma.InputJsonValue }),
      ...(supervision    !== undefined && { supervision }),
      ...(notify         !== undefined && { notify: notify as Prisma.InputJsonValue }),
      enabled:    enabled ?? true,
      created_by: caller.userId,
    },
  })

  return NextResponse.json({ trigger }, { status: 201 })
}
