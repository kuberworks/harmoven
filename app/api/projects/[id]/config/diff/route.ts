// app/api/projects/[id]/config/diff/route.ts
// GET /api/projects/:id/config/diff?from=<hash>&to=<hash>
// Returns a unified diff between two config versions.
// Requires project:edit permission (Amendment 83.10 rule 4).

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { GitConfigStore }            from '@/lib/config-git/config-store'

type Params = { params: Promise<{ id: string }> }

const HASH_RE = /^[0-9a-f]{7,40}$|^HEAD$/i

export async function GET(req: NextRequest, { params }: Params) {
  const { id: projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

  const { searchParams } = req.nextUrl
  const from = searchParams.get('from') ?? ''
  const to   = searchParams.get('to')   ?? 'HEAD'

  if (!HASH_RE.test(from) || !HASH_RE.test(to)) {
    return NextResponse.json({ error: 'Invalid commit hash' }, { status: 400 })
  }

  const store = new GitConfigStore()
  try {
    const diff = await store.diff(from, to)
    return NextResponse.json(diff)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to compute diff'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
