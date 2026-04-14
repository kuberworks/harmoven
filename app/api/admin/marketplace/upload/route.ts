// app/api/admin/marketplace/upload/route.ts
// POST /api/admin/marketplace/upload
// Multipart: file field (.hpkg / .harmoven.zip)
//
// B.3.2 — SEC-07, SEC-08, SEC-12

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { validateHpkg, persistHpkg, HpkgError } from '@/lib/marketplace/upload-hpkg'
import { assertImportReasonRequired, ImportReasonRequiredError } from '@/lib/marketplace/assert-import-reason'
import { checkRateLimitAsync } from '@/lib/auth/rate-limit'

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
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  // SEC-07: rate limit 5 uploads/userId/hour
  // Uses checkRateLimitAsync (keyed by userId) so that ALL attempts — including
  // those rejected by validation — count toward the quota. The previous
  // db.auditLog.count approach only counted approved uploads, which allowed
  // unlimited requests as long as no upload was approved.
  const rl = await checkRateLimitAsync(req, `upload:${caller.userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (rl) return rl

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
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
