// app/api/admin/integrations/[id]/route.ts
// Admin Integration management — enable/disable + delete
//
// PATCH  /api/admin/integrations/:id   — update enabled state and/or config
// DELETE /api/admin/integrations/:id   — permanently delete an integration
//
// Required permission: admin:integrations (instance_admin only — instance-level resource)
//
// Security: skill ID validated as UUID to prevent DB path-traversal curiosities.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller } from '@/lib/auth/rbac'
import { scanPackContent } from '@/lib/marketplace/scan'
import { uuidv7 } from '@/lib/utils/uuidv7'

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Auth helper ──────────────────────────────────────────────────────────────

type AdminGuardResult =
  | { caller: SessionCaller; err: null }
  | { caller: null;          err: NextResponse }

async function assertAdminSkills(req: NextRequest): Promise<AdminGuardResult> {
  const caller = await resolveCaller(req)
  if (!caller) {
    return { caller: null, err: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  try {
    assertInstanceAdmin(caller)  // narrows caller to SessionCaller
    return { caller, err: null }
  } catch (e) {
    const status = (e instanceof UnauthorizedError) ? 401 : 403
    return { caller: null, err: NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status }) }
  }
}

// ─── PATCH /api/admin/integrations/:id ──────────────────────────────────────

const PatchSkillBody = z.object({
  name:    z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  config:  z.record(z.unknown()).optional(),
  /** If provided, the content will be re-scanned before enabling. */
  content: z.string().max(1_000_000).optional(),
}).strict()

import { validateMcpConfig } from '@/lib/mcp/validate-config'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { caller, err } = await assertAdminSkills(req)
  if (err) return err

  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid skill ID' }, { status: 400 })
  }

  const existing = await db.mcpSkill.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PatchSkillBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { name, enabled, config, content } = parsed.data

  // Validate MCP config command allowlist (CVE-HARM-005)
  if (config) {
    const configErr = validateMcpConfig(config)
    if (configErr) {
      return NextResponse.json({ error: configErr }, { status: 422 })
    }
  }

  // Re-scan content whenever new content is provided, OR when enabling a pending skill
  let scanStatus = existing.scan_status
  // Prisma JsonNull sentinel required when storing null in a nullable JSON column
  let scanReport: Prisma.InputJsonValue | typeof Prisma.DbNull = existing.scan_report
    ? (existing.scan_report as Prisma.InputJsonValue)
    : Prisma.DbNull

  if (content) {
    const scan = scanPackContent(content)
    if (!scan.passed) {
      await db.auditLog.create({
        data: {
          id:          uuidv7(),
          actor:       caller.userId,
          action_type: 'skill_scan_failed',
          payload: { skill_id: id, name: existing.name, reason: scan.reason },
        },
      }).catch(() => { /* non-fatal */ })
      return NextResponse.json(
        { error: `Security scan failed: ${scan.reason}` },
        { status: 422 },
      )
    }
    scanStatus = 'passed'
    scanReport = { scanned_at: new Date().toISOString() } as object
  }

  // Prevent enabling a skill that hasn't been scanned yet
  if (enabled === true && scanStatus === 'pending') {
    return NextResponse.json(
      { error: 'Cannot enable a skill with pending scan status — provide content to scan it first' },
      { status: 409 },
    )
  }

  const updated = await db.mcpSkill.update({
    where: { id },
    data: {
      ...(name    !== undefined ? { name }                              : {}),
      ...(enabled  !== undefined ? { enabled }                          : {}),
      ...(config   !== undefined ? { config: config as object }        : {}),
      ...(content  !== undefined ? {
        scan_status: scanStatus,
        scan_report: scanReport,
      } : {}),
    },
  })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: enabled === true ? 'skill_enable' : enabled === false ? 'skill_disable' : 'skill_update',
      payload: {
        skill_id:   id,
        name:       existing.name,
        enabled:    updated.enabled,
        has_config: config !== undefined,
      },
    },
  }).catch(() => { /* non-fatal */ })

  return NextResponse.json({ skill: updated })
}

// ─── DELETE /api/admin/integrations/:id ─────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { caller, err } = await assertAdminSkills(req)
  if (err) return err

  const { id } = await params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid skill ID' }, { status: 400 })
  }

  const existing = await db.mcpSkill.findUnique({
    where: { id },
    select: { id: true, name: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
  }

  await db.mcpSkill.delete({ where: { id } })

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'skill_delete',
      payload: { skill_id: id, name: existing.name },
    },
  }).catch(() => { /* non-fatal */ })

  return new NextResponse(null, { status: 204 })
}
