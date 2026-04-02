// app/api/admin/marketplace/upload/route.ts
// POST /api/admin/marketplace/upload
// Multipart: file field (.hpkg / .harmoven.zip)
//
// B.3.2 — SEC-07, SEC-08, SEC-12

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { validateHpkg, persistHpkg, HpkgError } from '@/lib/marketplace/upload-hpkg'
import { assertImportReasonRequired, ImportReasonRequiredError } from '@/lib/marketplace/assert-import-reason'

// B.3.2: max 10 MB file
export const config = {
  api: { bodyParser: false },
}

const MAX_FILE_SIZE = 10_000_000 // 10 MB
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)

  // SEC-07: rate limit 5 uploads/userId/hour
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS)
  const recentUploads = await db.auditLog.count({
    where: {
      actor:       caller.userId,
      action_type: 'marketplace_upload_approved',
      timestamp:   { gte: windowStart },
    },
  })
  if (recentUploads >= RATE_LIMIT_MAX) {
    return NextResponse.json({ error: 'RATE_LIMITED', message: 'Upload limit reached (5 per hour).' }, { status: 429 })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'INVALID_FORM_DATA' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'FILE_REQUIRED' }, { status: 400 })
  }

  // Check filename
  const filename = file instanceof File ? file.name : 'unknown'
  if (!filename.endsWith('.hpkg') && !filename.endsWith('.harmoven.zip')) {
    return NextResponse.json({ error: 'INVALID_EXTENSION', message: 'File must be .hpkg or .harmoven.zip' }, { status: 422 })
  }

  // Max size
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'FILE_TOO_LARGE', message: 'File exceeds 10 MB limit.' }, { status: 422 })
  }

  const importReason = formData.get('import_reason')
  const importReasonStr = typeof importReason === 'string' ? importReason : undefined

  // L6: server-side import reason enforcement
  try {
    await assertImportReasonRequired(importReasonStr, null, false)
  } catch (err) {
    if (err instanceof ImportReasonRequiredError) {
      return NextResponse.json({ error: 'IMPORT_REASON_REQUIRED' }, { status: 422 })
    }
    throw err
  }

  const arrayBuf = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)

  // Run full validation + DB storage
  try {
    const { manifest, primaryContent, uploadSha256 } = await validateHpkg(buffer)
    const result = await persistHpkg(manifest, uploadSha256, caller.userId, importReasonStr)
    return NextResponse.json({ skill_id: result.skill_id, message: 'Package installed successfully.' }, { status: 201 })
  } catch (err) {
    if (err instanceof HpkgError) {
      // SEC-12: opaque violation count to client
      return NextResponse.json({ error: err.code, message: err.message }, { status: 422 })
    }
    throw err
  }
}
