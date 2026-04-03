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
import { refetchAtRef, GitHubImportError } from '@/lib/marketplace/from-github-url'
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
  name:        z.string().min(1).max(128).optional(),
  enabled:     z.boolean().optional(),
  config:      z.record(z.unknown()).optional(),
  /** If provided, the content will be re-scanned before enabling. */
  content:     z.string().max(1_000_000).optional(),
  // Additional editable metadata fields (vary by capability_type)
  author:      z.string().max(256).optional(),
  version:     z.string().max(128).optional(),
  source_ref:  z.string().max(256).optional(),
  tags:        z.array(z.string().max(64)).max(32).optional(),
  /**
   * MCP command shortcut — stored as config.command.
   * Accepted only when capability_type = mcp_skill.
   * If provided alongside config, config takes precedence for the full object.
   */
  mcp_command: z.string().max(512).optional(),
  /** Must be set to true when the re-fetched content contains external URLs. */
  scan_warnings_confirmed: z.boolean().optional(),
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

  const { name, enabled, config, content, author, version, source_ref, tags, mcp_command, scan_warnings_confirmed } = parsed.data

  // Build the resolved config: explicit config wins; mcp_command updates config.command
  let resolvedConfig: Record<string, unknown> | undefined = config
  if (mcp_command !== undefined && config === undefined) {
    const existingConfig = (existing.config ?? {}) as Record<string, unknown>
    resolvedConfig = { ...existingConfig, command: mcp_command }
  }

  // Validate MCP config command allowlist (CVE-HARM-005)
  if (resolvedConfig) {
    const configErr = validateMcpConfig(resolvedConfig)
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
  // When source_ref changes, re-fetch the pack file at the new ref and re-scan it
  let newSourceUrl: string | undefined

  if (source_ref !== undefined && source_ref !== existing.source_ref) {
    let fetched: { rawUrl: string; content: string; sha256: string; externalUrls: string[] }
    try {
      fetched = await refetchAtRef(existing.source_url ?? '', source_ref)
    } catch (e) {
      const msg = e instanceof GitHubImportError
        ? (e.code === 'FETCH_FAILED' ? `Ref "${source_ref}" not found or inaccessible` : e.detail.slice(0, 200))
        : 'Failed to fetch content at new ref'
      return NextResponse.json({ error: msg }, { status: 422 })
    }
    const scan = scanPackContent(fetched.content)
    // Prompt injection = hard block regardless of confirmation
    if (scan.hasInjection) {
      await db.auditLog.create({
        data: {
          id:          uuidv7(),
          actor:       caller.userId,
          action_type: 'skill_scan_failed',
          payload: { skill_id: id, name: existing.name, reason: scan.reason },
        },
      }).catch(() => { /* non-fatal */ })
      return NextResponse.json({ error: `Security scan failed: ${scan.violations.find(v => v.type === 'injection')?.reason ?? scan.reason}` }, { status: 422 })
    }
    // External URL = warning, requires explicit confirmation (same as import flow)
    if (scan.hasExternalUrl && !scan_warnings_confirmed) {
      return NextResponse.json(
        {
          error:        'This pack references external URLs. Set scan_warnings_confirmed: true to save.',
          code:         'SCAN_WARNINGS_UNCONFIRMED',
          external_urls: fetched.externalUrls,
        },
        { status: 422 },
      )
    }
    newSourceUrl = fetched.rawUrl
    scanStatus   = 'passed'
    scanReport   = { scanned_at: new Date().toISOString(), source: 'ref_update', content_sha256: fetched.sha256 } as object
  }

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
      ...(name           !== undefined ? { name }                                : {}),
      ...(enabled        !== undefined ? { enabled }                             : {}),
      ...(resolvedConfig !== undefined ? { config: resolvedConfig as object }    : {}),
      ...(author         !== undefined ? { author }                              : {}),
      ...(version        !== undefined ? { version }                             : {}),
      ...(source_ref     !== undefined ? { source_ref }                          : {}),
      ...(newSourceUrl   !== undefined ? { source_url: newSourceUrl }            : {}),
      ...(tags           !== undefined ? { tags }                                : {}),
      ...(content !== undefined || newSourceUrl !== undefined ? {
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
