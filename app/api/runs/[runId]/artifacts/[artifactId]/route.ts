// app/api/runs/[runId]/artifacts/[artifactId]/route.ts
// GET /api/runs/:runId/artifacts/:artifactId
// Streams artifact binary content as a download.
// Requires runs:read permission on the run's project.
//
// Security:
//   - IDOR: artifact.run_id === runId verified before RBAC check
//   - S1: Content-Disposition always "attachment" — prevents inline execution of HTML/SVG
//   - S1: Content-Type always application/octet-stream — MIME sniffing disabled
//   - S1: X-Content-Type-Options: nosniff — belt-and-suspenders MIME guard
//   - S1: Cache-Control: private, no-store — artifacts are user data, never CDN-cached
//   - S1: RFC 5987 filename encoding (handles accents / spaces / non-ASCII)
//   - S3: artifact_role !== 'discarded' — discarded artifacts return 404

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
  // Fetch artifact AND its run in one query; verify run_id matches URL parameter
  // to prevent IDOR (accessing another run's artifact by guessing its UUID).
  const artifact = await db.runArtifact.findUnique({
    where:   { id: artifactId },
    include: { run: { select: { project_id: true } } },
  })
  if (!artifact || artifact.run_id !== runId) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  // S3 — discarded artifacts → 404 (forward-compat: artifact_role added by MF-Phase1 migration)
  const role = (artifact as Record<string, unknown>)['artifact_role'] as string | undefined
  if (role === 'discarded') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
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

  // ─── S1: Force download — always attachment, always octet-stream ───────────
  // mime_type stored in DB is used only for UI icons; NEVER sent as Content-Type.
  // This prevents browsers from executing HTML/SVG artifacts inline.
  return new NextResponse(artifact.data, {
    headers: {
      'Content-Disposition':    `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      'Content-Type':           'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control':          'private, no-store',
    },
  })
}
