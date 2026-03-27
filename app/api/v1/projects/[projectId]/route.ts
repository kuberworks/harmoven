// app/api/v1/projects/[projectId]/route.ts
// GET /api/v1/projects/:projectId — Fetch a project by ID (public API v1).
// MISS-06 (audit gap).

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess }       from '@/lib/auth/ownership'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'

type Params = { params: Promise<{ projectId: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { projectId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let project
  try {
    project = await assertProjectAccess(caller, projectId)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ project })
}
