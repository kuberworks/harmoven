// app/api/admin/skills/route.ts
// Admin MCP Skill management — list + install
//
// GET  /api/admin/skills          — list all McpSkill rows
// POST /api/admin/skills          — register / install a new skill
//
// Required permission: admin:skills (held by project-admin and instance_admin)
// Admin routes are instance-level — no projectId in path.
// For non-project-scoped checks we verify the instanceRole directly:
//   instance_admin → full access (matches resolvePermissions fast-path)
//   project admin  → must have explicit admin:skills via their project role
//
// For simplicity and correctness, only instance_admin is accepted here because
// MCP skills are instance-wide (not project-scoped) — a project admin should not
// install instance-level capabilities without instance_admin approval.
//
// Security: all inputs validated with Zod strict mode.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller } from '@/lib/auth/rbac'
import { scanPackContent } from '@/lib/marketplace/scan'

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

// ─── GET /api/admin/skills ───────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { caller, err } = await assertAdminSkills(req)
  if (err) return err

  // Honour optional ?enabled=true|false filter
  const url      = new URL(req.url)
  const enabled  = url.searchParams.get('enabled')

  const where =
    enabled === 'true'  ? { enabled: true }  :
    enabled === 'false' ? { enabled: false } :
    {}

  const skills = await db.mcpSkill.findMany({
    where,
    orderBy: { installed_at: 'desc' },
  })

  return NextResponse.json({ skills })
}

// ─── POST /api/admin/skills ──────────────────────────────────────────────────
import { validateMcpConfig } from '@/lib/mcp/validate-config'

const InstallSkillBody = z.object({
  name:        z.string().min(1).max(128),
  source_url:  z.string().url().optional(),
  source_type: z.enum(['official', 'git', 'local']),
  version:     z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/).optional(),
  /** Raw content to scan for injection / external URLs (optional for local installs). */
  content:     z.string().max(1_000_000).optional(),
  config:      z.record(z.unknown()).optional(),
}).strict()

export async function POST(req: NextRequest) {
  const { caller, err } = await assertAdminSkills(req)
  if (err) return err

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = InstallSkillBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { name, source_url, source_type, version, content, config } = parsed.data

  // Validate MCP config command allowlist (CVE-HARM-005)
  if (config) {
    const configErr = validateMcpConfig(config)
    if (configErr) {
      return NextResponse.json({ error: configErr }, { status: 422 })
    }
  }

  // Security scan — only if content provided (for local / git sources)
  if (content) {
    const scan = scanPackContent(content)
    if (!scan.passed) {
      await db.auditLog.create({
        data: {
          actor:       caller.userId,
          action_type: 'skill_scan_failed',
          payload: { name, source_type, reason: scan.reason },
        },
      }).catch(() => { /* non-fatal */ })
      return NextResponse.json(
        { error: `Security scan failed: ${scan.reason}` },
        { status: 422 },
      )
    }
  }

  const skill = await db.mcpSkill.create({
    data: {
      name,
      source_url:  source_url ?? null,
      source_type,
      version:     version ?? null,
      approved_by: caller.userId,
      approved_at: new Date(),
      // Start as passed if content was scanned, pending otherwise
      scan_status: content ? 'passed' : 'pending',
      // scan_report defaults to null in Prisma schema — only set it when we have data
      ...(content ? { scan_report: { scanned_at: new Date().toISOString() } } : {}),
      enabled:     false,          // disabled by default — admin must enable explicitly
      config:      (config ?? {}) as object,
    },
  })

  await db.auditLog.create({
    data: {
      actor:       caller.userId,
      action_type: 'skill_install',
      payload: { skill_id: skill.id, name, source_type, version },
    },
  }).catch(() => { /* non-fatal */ })

  return NextResponse.json({ skill }, { status: 201 })
}
