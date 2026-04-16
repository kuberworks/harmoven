// app/api/admin/marketplace/skills/[id]/preview-diff/route.ts
// GET /api/admin/marketplace/skills/:id/preview-diff?preview_id=<id>&field=prompt_template
// Return full content of one changed field for the diff modal.
//
// B.4.1 / U10 — SEC-58, SEC-60 (rate-limited 60/preview/hour, ownership+expiry checked)

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { fetchCappedText } from '@/lib/marketplace/resolve-github-url'

// In-memory token bucket for SEC-60 (60 requests/preview_id/hour)
const previewBucket = new Map<string, { count: number; resetAt: number }>()
const BUCKET_MAX = 60
const BUCKET_WINDOW_MS = 60 * 60 * 1000

function checkPreviewRateLimit(previewId: string): boolean {
  const now = Date.now()
  let entry = previewBucket.get(previewId)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + BUCKET_WINDOW_MS }
    previewBucket.set(previewId, entry)
  }
  if (entry.count >= BUCKET_MAX) return false
  entry.count++
  return true
}

const QuerySchema = z.object({
  preview_id: z.string().min(1),
  field:      z.enum(['prompt_template', 'allowed_tools', 'description', 'version']),
})

type RouteParams = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
  const { id } = await params

  const queryParams = Object.fromEntries(req.nextUrl.searchParams)
  const parsed = QuerySchema.safeParse(queryParams)
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_PARAMS', details: parsed.error.flatten() }, { status: 400 })
  }
  const { preview_id, field } = parsed.data

  // SEC-60: rate limit 60/preview/hour
  if (!checkPreviewRateLimit(preview_id)) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: 'Too many preview-diff requests for this preview.' }, { status: 429 })
  }

  const preview = await db.gitHubImportPreview.findUnique({ where: { id: preview_id } })
  if (!preview) return NextResponse.json({ error: 'PREVIEW_NOT_FOUND' }, { status: 404 })

  // SEC-58: ownership + expiry
  if (preview.created_by !== caller.userId) {
    return NextResponse.json({ error: 'PREVIEW_NOT_OWNED' }, { status: 403 })
  }
  if (preview.expires_at < new Date()) {
    return NextResponse.json({ error: 'GONE' }, { status: 410 })
  }

  const skill = await db.mcpSkill.findUnique({ where: { id }, select: { id: true, source_url: true, version: true } })
  if (!skill) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const scaffold = preview.scaffold as { raw_url: string; new_sha256: string }
  const fileHashes = preview.file_hashes as Record<string, string>

  if (field === 'prompt_template') {
    // Re-fetch and verify SHA-256 before returning (SEC-58)
    let newContent: string
    try {
      newContent = await fetchCappedText(scaffold.raw_url, caller.userId)
    } catch {
      return NextResponse.json({ error: 'FETCH_FAILED' }, { status: 422 })
    }
    const actualSha256 = createHash('sha256').update(newContent, 'utf8').digest('hex')
    const expectedSha256 = fileHashes[scaffold.raw_url] ?? scaffold.new_sha256
    if (actualSha256 !== expectedSha256) {
      return NextResponse.json({ error: 'CONTENT_CHANGED' }, { status: 409 })
    }
    return NextResponse.json(
      { old: '', new: newContent },
      { headers: { 'Cache-Control': 'no-store' } }, // SEC-58: never cached
    )
  }

  // For other inline fields (description, version, allowed_tools) — return current vs preview scaffold values
  // These fields are returned from the check-update response directly; this endpoint is primarily for prompt_template
  return NextResponse.json({ error: 'FIELD_NOT_FETCHABLE', message: `Field "${field}" is returned inline from check-update, not via this endpoint.` }, { status: 422 })
}
