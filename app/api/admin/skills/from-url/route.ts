// app/api/admin/skills/from-url/route.ts
// POST /api/admin/skills/from-url
//
// Fetches a GitHub raw file URL, scaffolds a Harmoven pack preview, persists
// a GitHubImportPreview row with a 24h TTL and returns the scaffold to the admin
// for review before approval.
//
// Security controls:
//   SEC-01  Host whitelist enforced inside previewFromGitHubUrl()
//   SEC-02  redirect:error + 8s timeout + 1MB cap enforced inside previewFromGitHubUrl()
//   SEC-04  Double scan enforced inside previewFromGitHubUrl()
//   SEC-06  Only opaque error codes returned to client
//   SEC-07  Rate limit: 10 github_import_attempt per userId per hour (AuditLog COUNT)
//   SEC-08  instance_admin only
//   SEC-10  content_sha256 stored in GitHubImportPreview for hash-locking at approve
//   SEC-11  AuditLog writes are synchronous (no silent catch) for rate-limit integrity

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { previewFromGitHubUrl, GitHubImportError } from '@/lib/marketplace/from-github-url'
import { uuidv7 } from '@/lib/utils/uuidv7'

// ─── Constants ────────────────────────────────────────────────────────────────

const RATE_LIMIT_MAX  = 10
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const PREVIEW_TTL_MS  = 24 * 60 * 60 * 1000 // 24 hours

// ─── Client-safe error messages (SEC-06) ─────────────────────────────────────

const CLIENT_MESSAGES: Record<string, string> = {
  FORBIDDEN_HOST:    'URL non autorisée. Seuls raw.githubusercontent.com et api.github.com sont acceptés.',
  CONTENT_TOO_LARGE: 'Contenu trop volumineux (max 1 Mo).',
  FETCH_FAILED:      'Impossible de récupérer le fichier. Vérifiez l\'URL et réessayez.',
  PARSE_FAILED:      'Format de fichier non reconnu (TOML, YAML, JSON, Markdown attendus).',
  SCAN_FAILED:       'Contenu rejeté par le scanner de sécurité.',
  INVALID_PACK_ID:   'Nom de pack invalide — seuls [a-z0-9_] sont autorisés.',
  RATE_LIMITED:      'Trop de tentatives. Maximum 10 imports par heure.',
}

// ─── Input schema ─────────────────────────────────────────────────────────────

const PreviewBody = z.object({
  url: z.string().url().max(500),
}).strict()

// ─── SEC-07: Rate limit check ─────────────────────────────────────────────────

async function checkRateLimit(userId: string): Promise<void> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS)

  // SEC-11: synchronous — await without catch so a DB failure blocks the request
  // rather than silently allowing it (prevents rate-limit bypass via DB errors)
  const count = await db.auditLog.count({
    where: {
      actor:       userId,
      action_type: 'github_import_attempt',
      timestamp:   { gte: windowStart },
    },
  })

  if (count >= RATE_LIMIT_MAX) {
    // Log the rejected attempt before throwing
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       userId,
        action_type: 'github_import_rate_limited',
        payload:     { count, window_start: windowStart.toISOString() },
      },
    })
    throw new GitHubImportError('RATE_LIMITED', `Rate limit reached: ${count} attempts in window`)
  }
}

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

  const parsed = PreviewBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { url } = parsed.data

  // SEC-07: rate limit check (SEC-11: throws = blocks if DB fails)
  try {
    await checkRateLimit(caller.userId)
  } catch (e) {
    if (e instanceof GitHubImportError && e.code === 'RATE_LIMITED') {
      return NextResponse.json({ error: CLIENT_MESSAGES['RATE_LIMITED'] }, { status: 429 })
    }
    // DB failure — fail closed
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }

  // SEC-11: Audit the attempt BEFORE fetch (synchronous — no .catch())
  const attemptLogId = uuidv7()
  await db.auditLog.create({
    data: {
      id:          attemptLogId,
      actor:       caller.userId,
      action_type: 'github_import_attempt',
      payload:     { url },
    },
  })

  // Fetch, parse, scan, scaffold
  let preview: Awaited<ReturnType<typeof previewFromGitHubUrl>>
  try {
    preview = await previewFromGitHubUrl(url)
  } catch (e) {
    const code   = e instanceof GitHubImportError ? e.code : 'FETCH_FAILED'
    const detail = e instanceof Error ? e.message : String(e)

    // SEC-11: Log technical detail server-side (synchronous)
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'github_import_failed',
        payload:     { url, code, detail: detail.slice(0, 500) },
      },
    })

    // SEC-06: Return opaque message to client
    return NextResponse.json(
      { error: CLIENT_MESSAGES[code] ?? CLIENT_MESSAGES['FETCH_FAILED'] },
      { status: 422 },
    )
  }

  // SEC-10: Persist preview with content_sha256 for hash-locking at approval
  const previewId = uuidv7()
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS)

  await db.gitHubImportPreview.create({
    data: {
      id:             previewId,
      actor:          caller.userId,
      source_url:     url,
      content_sha256: preview.content_sha256,
      scaffold:       preview as object,
      expires_at:     expiresAt,
    },
  })

  return NextResponse.json({
    preview_id: previewId,
    preview,
    expires_at: expiresAt.toISOString(),
  }, { status: 201 })
}
