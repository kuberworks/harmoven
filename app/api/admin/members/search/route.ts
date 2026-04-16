// app/api/admin/members/search/route.ts
// Search project members by name or email.
//
// GET /api/admin/members/search?q=<query>
//
// Required: instance_admin or admin role.
//
// SECURITY:
//   - Minimum query length of 3 characters enforced server-side.
//     This prevents bulk enumeration: a caller cannot scan the full member
//     list by querying "" or "a", "b", etc. — they must know at least a
//     fragment of name or email.
//   - Hard result cap of 10 rows. No total count returned (avoids probing
//     "how many users match *" style attacks).
//   - Only users who are project members (or instance_admin) are returned.
//     Regular accounts with no project memberships are invisible here.

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { UnauthorizedError }         from '@/lib/auth/rbac'

const MIN_QUERY_LEN = 3
const MAX_RESULTS   = 10

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Allow both instance_admin and admin (org-level admin)
  if (caller.type !== 'session') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const role = caller.instanceRole
  if (role !== 'instance_admin' && role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()

  // Enforce minimum length — security gate against bulk enumeration
  if (q.length < MIN_QUERY_LEN) {
    return NextResponse.json({ results: [] })
  }

  // Search users whose name or email contains the query (case-insensitive).
  // Only return users who have at least one project membership OR are instance_admin —
  // regular accounts with no project access are not visible here.
  const users = await db.user.findMany({
    where: {
      AND: [
        {
          OR: [
            { name:  { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        {
          OR: [
            { role: 'instance_admin' },
            { project_memberships: { some: {} } },
          ],
        },
      ],
    },
    select: {
      id:    true,
      name:  true,
      email: true,
      role:  true,
      project_memberships: {
        select: {
          project: { select: { id: true, name: true } },
          role:    { select: { display_name: true, name: true } },
        },
        orderBy: { project: { name: 'asc' } },
      },
    },
    take: MAX_RESULTS,
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({ results: users })
}
