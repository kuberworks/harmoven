// app/api/projects/[id]/api-keys/[keyId]/route.ts
// DELETE /api/projects/:id/api-keys/:keyId  — Revoke an API key (soft-delete)
//
// Auth: project:credentials required.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import {
  resolvePermissions,
  ForbiddenError,
  UnauthorizedError,
  invalidatePermCache,
} from '@/lib/auth/rbac'
import { revokeProjectApiKey } from '@/lib/auth/project-api-key'
import { db } from '@/lib/db/client'
import { uuidv7 } from '@/lib/utils/uuidv7'

type Params = { params: Promise<{ id: string; keyId: string }> }

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id: projectId, keyId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:credentials')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const revoked = await revokeProjectApiKey(keyId, projectId)
  if (!revoked) {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 })
  }

  // SEC-C-03: Immediately invalidate the in-process permission cache for this key.
  // Without this, the revoked key could still be accepted for up to 60 s (PERM_CACHE_TTL_MS).
  // We construct an ApiKeyCaller shape to match the cache key format "apikey:<keyId>:<projectId>".
  invalidatePermCache({ type: 'api_key', keyId }, projectId)

  const actorId = caller.type === 'session' ? caller.userId : `apikey:${caller.keyId}`
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'api_key_revoked',
      payload:     { project_id: projectId, key_id: keyId },
    },
  })

  return new NextResponse(null, { status: 204 })
}
