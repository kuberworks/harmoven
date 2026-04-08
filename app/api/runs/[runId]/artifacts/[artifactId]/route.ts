// app/api/runs/[runId]/artifacts/[artifactId]/route.ts
// GET /api/runs/:runId/artifacts/:artifactId
// Streams artifact binary content as a download.
// Requires runs:read permission on the run's project.
//
// Security:
//   - IDOR: artifact.run_id === runId verified before RBAC check
//   - X-Content-Type-Options: nosniff (prevent MIME sniffing XSS)
//   - Content-Security-Policy: sandbox (prevents script execution if navigated directly)
//   - Content-Disposition: attachment (force download, never inline)
//   - RFC 5987 filename encoding (handles accents / spaces / non-ASCII)
//   - Cache-Control: private, no-store (artifacts are user data, never CDN-cached)

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

  // ─── Build Content-Disposition (RFC 5987) ─────────────────────────────────
  // ASCII fallback for legacy clients + UTF-8 encoded name for modern clients.
  const ascii    = artifact.filename.replace(/[^\x20-\x7E]/g, '_')
  const encoded  = encodeURIComponent(artifact.filename)
  const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`

  // ─── Stream binary response ────────────────────────────────────────────────
  return new NextResponse(artifact.data, {
    status: 200,
    headers: {
      'Content-Type':            artifact.mime_type,
      'Content-Disposition':     disposition,
      'Content-Length':          String(artifact.size_bytes),
      'X-Content-Type-Options':  'nosniff',
      'Content-Security-Policy': 'sandbox',
      'Cache-Control':           'private, no-store',
    },
  })
}
