// app/api/projects/[id]/config/history/route.ts
// GET /api/projects/:id/config/history
// Returns the git version history of a project's config files.
// Requires project:edit permission (Amendment 83.10 rule 4).

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { GitConfigStore }            from '@/lib/config-git/config-store'

type Params = { params: Promise<{ id: string }> }

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

  const store    = new GitConfigStore()
  const versions = await store.history(projectId)

  // Serialize timestamps as ISO strings for JSON transport
  return NextResponse.json(
    versions.map((v) => ({
      ...v,
      timestamp: v.timestamp instanceof Date ? v.timestamp.toISOString() : v.timestamp,
    })),
  )
}
