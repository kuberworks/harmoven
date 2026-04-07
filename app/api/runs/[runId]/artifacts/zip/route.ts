// app/api/runs/[runId]/artifacts/zip/route.ts
// GET /api/runs/:runId/artifacts/zip?node_id=<optional>
// Returns a ZIP archive of all artifacts for the run (or a specific node).
// Requires runs:read permission on the run's project.
//
// Security:
//   - Same IDOR + RBAC chain as the single-artifact download route.
//   - Filenames read from DB are already sanitised by the worker
//     (/[^a-zA-Z0-9._-]/ → '_', max 200 chars). No re-sanitisation needed.
//   - ZIP entries are namespaced as <node_id>/<filename> when multiple nodes
//     are bundled to prevent filename collisions across nodes.
//   - Content-Disposition: attachment — never inline.
//   - Cache-Control: private, no-store — artifacts are user data.
//   - Total artifact size is capped server-side at 50 MB by the executor
//     so the ZIP buffer fits comfortably in Node.js heap.

import { NextRequest, NextResponse } from 'next/server'
import JSZip from 'jszip'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { db } from '@/lib/db/client'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params
  const nodeId = req.nextUrl.searchParams.get('node_id') ?? undefined

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ─── Run lookup ────────────────────────────────────────────────────────────
  const run = await db.run.findUnique({
    where:  { id: runId },
    select: { project_id: true },
  })
  if (!run) return NextResponse.json({ error: 'Not Found' }, { status: 404 })

  // ─── Project access ────────────────────────────────────────────────────────
  try {
    await assertProjectAccess(caller, run.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden' },    { status: 403 })
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, run.project_id)
  if (!perms.has('runs:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Fetch artifacts with binary data ─────────────────────────────────────
  // Include `data` only here (not in the list endpoint) so listing stays cheap.
  const where = nodeId
    ? { run_id: runId, node_id: nodeId }
    : { run_id: runId }

  const artifacts = await db.runArtifact.findMany({
    where,
    select: { node_id: true, filename: true, data: true },
    orderBy: { created_at: 'asc' },
  })

  if (artifacts.length === 0) {
    return NextResponse.json({ error: 'No artifacts found' }, { status: 404 })
  }

  // ─── Build ZIP ─────────────────────────────────────────────────────────────
  // When the ZIP spans multiple nodes, namespace entries as <node_id>/<filename>
  // to prevent collisions if two nodes produced files with the same name.
  // When scoped to a single node, use a flat structure for a cleaner archive.
  const nodeIds = [...new Set(artifacts.map(a => a.node_id))]
  const useNamespace = nodeIds.length > 1

  const zip = new JSZip()
  for (const artifact of artifacts) {
    const entryName = useNamespace
      ? `${artifact.node_id}/${artifact.filename}`
      : artifact.filename
    zip.file(entryName, artifact.data)
  }

  const buffer = await zip.generateAsync({
    type:               'nodebuffer',
    compression:        'DEFLATE',
    compressionOptions: { level: 6 },
  })

  // ─── Response ──────────────────────────────────────────────────────────────
  const zipName = nodeId
    ? `harmoven-${runId.slice(0, 8)}-${nodeId}.zip`
    : `harmoven-${runId.slice(0, 8)}.zip`

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type':        'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Content-Length':      String(buffer.length),
      'Cache-Control':       'private, no-store',
    },
  })
}
