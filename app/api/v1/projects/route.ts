// app/api/v1/projects/route.ts
// GET /api/v1/projects — List projects accessible to the caller (public API v1).
// MISS-06 (audit gap).

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { UnauthorizedError }         from '@/lib/auth/rbac'

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    // instance_admin sees all projects; API key caller sees only its project.
    if (caller.type === 'api_key') {
      const keyRow = await db.projectApiKey.findUnique({
        where:  { id: caller.keyId },
        select: { project: true },
      })
      if (!keyRow) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      return NextResponse.json({ projects: [keyRow.project] })
    }

    // Session caller: return projects they are a member of.
    // instance_admin can see all.
    const user = await db.user.findUnique({
      where: { id: caller.userId },
      select: { role: true },
    })
    if (user?.role === 'instance_admin') {
      const projects = await db.project.findMany({ orderBy: { created_at: 'desc' } })
      return NextResponse.json({ projects })
    }

    const memberships = await db.projectMember.findMany({
      where:   { user_id: caller.userId },
      include: { project: true },
    })
    const projects = memberships.map(m => m.project)
    return NextResponse.json({ projects })
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    throw e
  }
}
