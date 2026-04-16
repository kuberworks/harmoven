// app/api/runs/[runId]/artifacts/[artifactId]/preview/route.ts
// GET /api/runs/:runId/artifacts/:artifactId/preview
// Serves image artifacts inline (Content-Type: image/*) for thumbnail display.
//
// Security:
//   - Only serves mime_type starting with 'image/' — non-image artifacts → 404
//   - Same IDOR + RBAC checks as the main artifact endpoint
//   - Cache-Control: private, max-age=3600 (safe for user-scoped images)
//   - No X-Content-Type-Options bypass: inline is intentional for images only

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; artifactId: string }> },
) {
  const { runId, artifactId } = await params

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ─── Artifact + IDOR check ────────────────────────────────────────────────
  const artifact = await db.runArtifact.findUnique({
    where:   { id: artifactId },
    include: { run: { select: { project_id: true } } },
  })
  if (!artifact || artifact.run_id !== runId) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  // Only serve non-discarded image artifacts
  const role = (artifact as Record<string, unknown>)['artifact_role'] as string | undefined
  if (role === 'discarded') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }
  if (!artifact.mime_type.startsWith('image/')) {
    return NextResponse.json({ error: 'Not an image artifact' }, { status: 404 })
  }

  // ─── Project access ────────────────────────────────────────────────────────
  try {
    await assertProjectAccess(caller, artifact.run.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden' },    { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, artifact.run.project_id)
  if (!perms.has('runs:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Serve inline ──────────────────────────────────────────────────────────
  return new NextResponse(artifact.data, {
    headers: {
      'Content-Type':  artifact.mime_type,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
