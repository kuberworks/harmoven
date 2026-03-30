// app/api/projects/[id]/config/restore/route.ts
// POST /api/projects/:id/config/restore  { hash: string }
// Restores project config to a previous version (new forward commit — history never rewritten).
// Requires project:edit permission (Amendment 83.10 rule 4).

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { GitConfigStore }            from '@/lib/config-git/config-store'

type Params = { params: Promise<{ id: string }> }

const HASH_RE = /^[0-9a-f]{7,40}$/i

export async function POST(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // API keys cannot perform restores — session only
  if (caller.type !== 'session') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, projectId)
  if (!perms.has('project:edit')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const hash = typeof body['hash'] === 'string' ? body['hash'].trim() : ''
  if (!HASH_RE.test(hash)) {
    return NextResponse.json({ error: 'Invalid or missing commit hash' }, { status: 400 })
  }

  const store = new GitConfigStore()
  try {
    const version = await store.restore(hash, caller.userId)
    return NextResponse.json({
      version: {
        ...version,
        timestamp: version.timestamp instanceof Date ? version.timestamp.toISOString() : version.timestamp,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Restore failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
