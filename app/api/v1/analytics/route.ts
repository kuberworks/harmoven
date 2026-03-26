// app/api/v1/analytics/route.ts
// GET /api/v1/analytics
// Public API analytics route — supports session AND API key auth.
//
// Auth rules — Amendment 85:
//   • instance_admin session caller  → full access (all projects)
//   • API key caller                  → must supply project_id; key must
//                                       have runs:read on that project, gets
//                                       scoped + anonymized view
//   • session caller with project:admin on ?project_id → scoped + anonymized
//
// Query parameters: from, to, project_id?, granularity?, format? (json|csv|pdf)

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { assertProjectAccess } from '@/lib/auth/ownership'
import { getAnalyticsConfig } from '@/lib/analytics/config'
import { buildAnalyticsResponse, parseAnalyticsQuery } from '@/lib/analytics/handler'
import { toJson, toCsv, toPdfHtml } from '@/lib/analytics/export'

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ─── Parse query ───────────────────────────────────────────────────────────
  const { query, format, error } = parseAnalyticsQuery(req.nextUrl.searchParams)
  if (error) return NextResponse.json({ error }, { status: 400 })

  // ─── Scope / permission check ──────────────────────────────────────────────
  let anonymize = false

  const isAdminSession =
    caller.type === 'session' && caller.instanceRole === 'instance_admin'

  if (!isAdminSession) {
    // All non-admin callers must target a specific project.
    if (!query.project_id) {
      return NextResponse.json(
        { error: 'Forbidden — supply project_id or use an instance_admin account' },
        { status: 403 },
      )
    }

    // For API keys: verify the key is associated with the requested project.
    try {
      await assertProjectAccess(caller, query.project_id)
    } catch (e) {
      if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Verify the caller has at least runs:read in that project.
    try {
      const perms = await resolvePermissions(caller, query.project_id)
      if (!perms.has('runs:read')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } catch (e) {
      if (e instanceof ForbiddenError) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Non-admin callers always receive anonymized data (Am.85.10)
    anonymize = true
  }

  // ─── Config ────────────────────────────────────────────────────────────────
  const config = getAnalyticsConfig()
  if (!config.enabled) {
    return NextResponse.json({ error: 'Analytics is disabled' }, { status: 503 })
  }

  // ─── Compute ───────────────────────────────────────────────────────────────
  const data = await buildAnalyticsResponse({ query, config, anonymize })

  // ─── Respond ───────────────────────────────────────────────────────────────
  if (format === 'csv') {
    return new NextResponse(toCsv(data), {
      headers: {
        'Content-Type':        'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="analytics.csv"',
      },
    })
  }

  if (format === 'pdf') {
    return new NextResponse(toPdfHtml(data), {
      headers: {
        'Content-Type':        'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="analytics-report.html"',
      },
    })
  }

  // Default: JSON
  return NextResponse.json(data)
}
