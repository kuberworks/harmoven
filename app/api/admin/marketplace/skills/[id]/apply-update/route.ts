// app/api/admin/marketplace/skills/[id]/apply-update/route.ts
// POST /api/admin/marketplace/skills/:id/apply-update
// Verify preview, re-scan, apply update in DB transaction.
//
// B.4.2 — SEC-10, SEC-44, SEC-45

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError, ForbiddenError } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { fetchCappedText } from '@/lib/marketplace/resolve-github-url'
import { runDoubleScan, buildScanResult } from '@/lib/marketplace/static-safety-scan'
import { Prisma } from '@prisma/client'

const BodySchema = z.object({
  preview_id: z.string().min(1),
})

type RouteParams = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
  const { id } = await params

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, { status: 422 })
  }
  const { preview_id } = parsed.data

  // Load preview
  const preview = await db.gitHubImportPreview.findUnique({ where: { id: preview_id } })
  if (!preview) return NextResponse.json({ error: 'PREVIEW_NOT_FOUND' }, { status: 404 })

  // SEC-44: ownership check
  if (preview.created_by !== caller.userId) {
    return NextResponse.json({ error: 'PREVIEW_NOT_OWNED' }, { status: 403 })
  }

  // SEC-41: TTL check
  if (preview.expires_at < new Date()) {
    return NextResponse.json({ error: 'GONE', message: 'Preview has expired. Run a new check.' }, { status: 410 })
  }

  const skill = await db.mcpSkill.findUnique({ where: { id } })
  if (!skill) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (skill.source_type !== 'git') {
    return NextResponse.json({ error: 'NOT_GIT_SOURCE' }, { status: 422 })
  }

  const scaffold = preview.scaffold as {
    raw_url: string
    new_sha256: string
    skill_id: string
  }

  if (scaffold.skill_id !== id) {
    return NextResponse.json({ error: 'PREVIEW_SKILL_MISMATCH' }, { status: 422 })
  }

  // Re-fetch and verify SHA-256 (SEC-10)
  let newContent: string
  try {
    newContent = await fetchCappedText(scaffold.raw_url, caller.userId)
  } catch {
    return NextResponse.json({ error: 'FETCH_FAILED', message: 'Could not re-fetch source file.' }, { status: 422 })
  }

  const actualSha256 = createHash('sha256').update(newContent, 'utf8').digest('hex')
  if (actualSha256 !== scaffold.new_sha256) {
    return NextResponse.json({ error: 'CONTENT_CHANGED', message: 'Source content changed since the check was performed.' }, { status: 409 })
  }

  // Run double scan (SEC-04)
  const violations = runDoubleScan(newContent)
  if (violations.length > 0) {
    const scanResult = buildScanResult(violations)
    return NextResponse.json({ error: 'CONTENT_SCAN_FAILED', message: scanResult.clientSummary }, { status: 422 })
  }

  // Apply in transaction; SEC-45: reset enabled = false
  await db.$transaction(async (tx) => {
    await tx.mcpSkill.update({
      where: { id },
      data: {
        installed_sha256: actualSha256,
        enabled:          false,      // SEC-45
        pending_update:   Prisma.DbNull,  // clear pending update (SEC-49)
      },
    })

    await tx.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'marketplace_git_update_applied',
        payload:     {
          skill_id:       id,
          new_sha256:     actualSha256,
          changed_fields: ['prompt_template'],
        },
      },
    })
  })

  return NextResponse.json({ skill_id: id, message: 'Update applied. Skill disabled — re-enable after reviewing.' })
}
