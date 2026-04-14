// app/api/admin/marketplace/skills/[id]/check-update/route.ts
// POST /api/admin/marketplace/skills/:id/check-update
// Re-fetch source, compute SHA-256 diff, return preview_id.
//
// B.4.1 — SEC-01, SEC-02, SEC-10, SEC-36, SEC-44
// Rate limit: 20 update checks per userId per hour

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { assertHostWhitelisted, fetchCappedText } from '@/lib/marketplace/resolve-github-url'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import { resolveGitToken } from '@/lib/marketplace/git-provider-tokens'
import { runDoubleScan } from '@/lib/marketplace/static-safety-scan'

// ─── Local helper (mirrors update-checker.ts) ────────────────────────────────

function buildRawUrl(sourceUrl: string, sourceRef: string | undefined): string {
  const match = sourceUrl.match(/github\.com\/([^/]+)\/([^/]+)(?:\/blob\/([^/]+))?\/(.+)/)
  if (match) {
    const [, owner, repo, , filePath] = match as [string, string, string, string, string]
    const ref = sourceRef || 'HEAD'
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`
  }
  if (sourceUrl.includes('raw.githubusercontent.com')) return sourceUrl
  throw new Error(`Cannot construct raw URL from: ${sourceUrl}`)
}

const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000 // default 24h; configurable

type RouteParams = { params: Promise<{ id: string }> }

async function getPreviewTtlMs(): Promise<number> {
  const row = await db.systemSetting.findUnique({
    where: { key: 'marketplace.smart_import.preview_ttl_hours' },
  })
  const hours = parseInt(row?.value ?? '24', 10)
  const clamped = Math.max(1, Math.min(168, isNaN(hours) ? 24 : hours))
  return clamped * 60 * 60 * 1000
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
  const { id } = await params

  const skill = await db.mcpSkill.findUnique({
    where: { id },
    select: {
      id:               true,
      source_type:      true,
      source_url:       true,
      source_ref:       true,
      installed_sha256: true,
      version:          true,
    },
  })

  if (!skill) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (skill.source_type !== 'git') {
    return NextResponse.json({ error: 'NOT_GIT_SOURCE', message: 'Only git-sourced skills can be checked for updates.' }, { status: 422 })
  }
  if (!skill.source_url) {
    return NextResponse.json({ error: 'NO_SOURCE_URL' }, { status: 422 })
  }

  // Rate limit: 20 checks/userId/hour
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS)
  const count = await db.auditLog.count({
    where: {
      actor:       caller.userId,
      action_type: 'marketplace_git_update_checked',
      timestamp:   { gte: windowStart },
    },
  })
  if (count >= RATE_LIMIT_MAX) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: `Update check limit reached (${RATE_LIMIT_MAX}/hour).` }, { status: 429 })
  }

  // Whitelist + SSRF check
  try {
    const parsedUrl = new URL(skill.source_url)
    await assertHostWhitelisted(parsedUrl.hostname)
    await assertNotPrivateHost(skill.source_url)
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : 'HOST_ERROR'
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'marketplace_git_update_checked',
        payload:     { skill_id: id, error: code },
      },
    })
    return NextResponse.json({ error: code, message: 'Source URL is not allowed by whitelist or SSRF policy.' }, { status: 422 })
  }

  try {
    // Build raw content URL
    let rawUrl: string
    if (skill.source_url.includes('raw.githubusercontent.com')) {
      rawUrl = skill.source_url
    } else {
      rawUrl = buildRawUrl(skill.source_url, skill.source_ref ?? undefined)
    }

    const newContent = await fetchCappedText(rawUrl, caller.userId)
    const newSha256 = createHash('sha256').update(newContent, 'utf8').digest('hex')

    // AuditLog
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'marketplace_git_update_checked',
        payload:     { skill_id: id, up_to_date: newSha256 === skill.installed_sha256 },
      },
    })

    if (newSha256 === (skill.installed_sha256 ?? '')) {
      return NextResponse.json({ up_to_date: true, current_version: skill.version })
    }

    // Changes detected — store preview
    const ttlMs = await getPreviewTtlMs()
    const previewId = uuidv7()
    await db.gitHubImportPreview.create({
      data: {
        id:             previewId,
        actor:          caller.userId,
        source_url:     rawUrl,
        content_sha256: newSha256,
        created_by:     caller.userId,
        expires_at:     new Date(Date.now() + ttlMs),
        file_hashes:    { [rawUrl]: newSha256 },
        context:        'update_check',
        scaffold: {
          skill_id:   id,
          source_url: skill.source_url,
          source_ref: skill.source_ref,
          raw_url:    rawUrl,
          new_sha256: newSha256,
        },
      },
    })

    // Compute simple changes list
    const changes: Array<{ field: string; old_sha256: string | null; new_sha256: string; size_bytes: number }> = [
      {
        field:      'prompt_template',
        old_sha256: skill.installed_sha256 ?? null,
        new_sha256: newSha256,
        size_bytes: Buffer.byteLength(newContent, 'utf8'),
      },
    ]

    return NextResponse.json({
      up_to_date:      false,
      current_version: skill.version,
      changes,
      preview_id:      previewId,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : 'UNKNOWN_ERROR'
    return NextResponse.json({ error: 'FETCH_FAILED', message: msg }, { status: 422 })
  }
}
