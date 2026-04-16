// app/api/admin/integrations/from-url/approve/route.ts
// POST /api/admin/integrations/from-url/approve
//
// Approves a previewed GitHub import and creates a McpSkill row.
//
// Security controls:
//   SEC-08  instance_admin only
//   SEC-09  Returns 422 if any inferred field was not confirmed by the admin
//   SEC-10  Re-fetches content and compares SHA-256 to preview hash — rejects if changed
//   SEC-11  All AuditLog writes are synchronous
//   SEC-03  Pack starts with enabled:false — admin must enable separately

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import { previewFromGitHubUrl, GitHubImportError, type GitHubImportPreview } from '@/lib/marketplace/from-github-url'
import { validateMcpConfig } from '@/lib/mcp/validate-config'
import { uuidv7 } from '@/lib/utils/uuidv7'

// ─── Input schema ─────────────────────────────────────────────────────────────

const ApproveBody = z.object({
  preview_id: z.string().uuid(),
  /** Admin-confirmed (and optionally edited) field values. */
  confirmed: z.object({
    pack_id:        z.string().regex(/^[a-z0-9_]{1,64}$/),
    name:           z.string().min(1).max(256),
    version:        z.string().min(1).max(128),
    commit_sha:     z.string().max(40).optional(),
    author:         z.string().max(256),
    description:    z.string().max(4096),
    system_prompt:  z.string().max(1_000_000),
    tags:           z.array(z.string().max(64)).max(32),
    capability_type: z.enum(['domain_pack', 'mcp_skill', 'prompt_only', 'harmoven_agent', 'js_ts_plugin', 'slash_command']),
    mcp_command:    z.string().optional(),
    /** Must be true when the preview contains scan_warnings (external URL refs). */
    scan_warnings_confirmed: z.boolean().optional(),
  }).strict(),
}).strict()

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // SEC-08: instance_admin only
  const caller = await resolveCaller(req)
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    assertInstanceAdmin(caller)
  } catch (e) {
    const status = (e instanceof UnauthorizedError) ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  // Parse body
  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = ApproveBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { preview_id, confirmed } = parsed.data

  // Load preview row
  const previewRow = await db.gitHubImportPreview.findUnique({
    where: { id: preview_id },
  })

  if (!previewRow) {
    return NextResponse.json({ error: 'Preview not found or expired.' }, { status: 404 })
  }

  // Verify ownership — the approving admin must be the one who initiated the preview
  if (previewRow.actor !== caller.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Check TTL (SEC-10)
  if (new Date() > previewRow.expires_at) {
    await db.gitHubImportPreview.delete({ where: { id: preview_id } }).catch(() => {})
    return NextResponse.json({ error: 'Preview expired. Please re-import the URL.' }, { status: 410 })
  }

  // SEC-10: Re-fetch and compare SHA-256 to detect content changes since preview
  let freshPreview: GitHubImportPreview
  try {
    freshPreview = await previewFromGitHubUrl(previewRow.source_url)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    // SEC-11: synchronous AuditLog
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'github_import_approve_refetch_failed',
        payload:     { preview_id, source_url: previewRow.source_url, detail: detail.slice(0, 500) },
      },
    })
    const code = e instanceof GitHubImportError ? e.code : 'FETCH_FAILED'
    return NextResponse.json(
      { error: `Re-fetch failed: ${code}. The file may have been removed.` },
      { status: 422 },
    )
  }

  // SEC-10: Hash comparison — reject if content changed between preview and approve
  if (freshPreview.content_sha256 !== previewRow.content_sha256) {
    // SEC-11: synchronous AuditLog
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'github_import_content_changed',
        payload: {
          preview_id,
          source_url:        previewRow.source_url,
          hash_at_preview:   previewRow.content_sha256,
          hash_at_approve:   freshPreview.content_sha256,
        },
      },
    })
    return NextResponse.json(
      {
        error: 'File content changed since preview. Re-import the URL to re-validate.',
        code:  'CONTENT_CHANGED',
      },
      { status: 409 },
    )
  }

  // Validate mcp_command against the execution-time allowlist before storing
  // (belt-and-suspenders with lib/mcp/client.ts CVE-HARM-005 guard).
  if (confirmed.mcp_command) {
    const mcpErr = validateMcpConfig({ command: confirmed.mcp_command, args: [] })
    if (mcpErr) {
      return NextResponse.json({ error: mcpErr }, { status: 422 })
    }
  }

  // If the preview contains external URL warnings, admin must explicitly confirm them
  const scaffold = previewRow.scaffold as { scan_warnings?: unknown[] } | null
  const hasScanWarnings = Array.isArray(scaffold?.scan_warnings) && scaffold.scan_warnings.length > 0
  if (hasScanWarnings && !confirmed.scan_warnings_confirmed) {
    return NextResponse.json(
      { error: 'This pack references external URLs. Set scan_warnings_confirmed: true to approve.', code: 'SCAN_WARNINGS_UNCONFIRMED' },
      { status: 422 },
    )
  }

  // Create the McpSkill row with confirmed values (SEC-08: enabled:false)
  const skill = await db.mcpSkill.create({
    data: {
      id:          uuidv7(),
      name:            confirmed.name,
      source_url:      previewRow.source_url,
      source_type:     'git',
      version:         confirmed.version,
      source_ref:      confirmed.commit_sha
        ? `${confirmed.version}+${confirmed.commit_sha}`
        : confirmed.version,
      pack_id:         confirmed.pack_id         || undefined,
      author:          confirmed.author          || undefined,
      tags:            confirmed.tags            ?? [],
      capability_type: confirmed.capability_type,
      approved_by:     caller.userId,
      approved_at:     new Date(),
      scan_status:     'passed',
      scan_report: {
        scanned_at:     new Date().toISOString(),
        source:         'github_import',
        content_sha256: freshPreview.content_sha256,
        capability_type: confirmed.capability_type,
      },
      enabled: false,  // SEC-08: must be explicitly enabled by admin after creation
      config:  confirmed.mcp_command
        ? { command: confirmed.mcp_command, args: [] }
        : {},
    },
  })

  // Cleanup preview row (no longer needed)
  await db.gitHubImportPreview.delete({ where: { id: preview_id } }).catch(() => {})

  // SEC-11: synchronous AuditLog
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'github_import_approved',
      payload: {
        skill_id:       skill.id,
        source_url:     previewRow.source_url,
        pack_id:        confirmed.pack_id,
        capability_type: confirmed.capability_type,
        content_sha256: freshPreview.content_sha256,
      },
    },
  })

  return NextResponse.json(
    { skill_id: skill.id },
    { status: 201 },
  )
}
