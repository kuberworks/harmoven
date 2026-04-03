// app/api/analytics/route.ts
// GET /api/analytics
// Internal analytics route — session auth only (no API key support here).
//
// Auth rules — Amendment 85:
//   • caller.instanceRole === 'instance_admin'  → full access (all projects)
//   • session caller with project:admin on ?project_id  → scoped + anonymized
//   • API key callers → 403 (instance-level operation, keys are project-scoped)
//
// Query parameters: from, to, project_id?, granularity?, format? (json|csv|pdf)

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { getAnalyticsConfig } from '@/lib/analytics/config'
import { buildAnalyticsResponse, parseAnalyticsQuery } from '@/lib/analytics/handler'
import { toJson, toCsv, toPdfHtml } from '@/lib/analytics/export'

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // API keys are project-scoped; use /api/v1/analytics for API key access.
  if (caller.type === 'api_key') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const isAdmin = caller.instanceRole === 'instance_admin'

  // ─── Parse query ───────────────────────────────────────────────────────────
  const { query, format, error } = parseAnalyticsQuery(req.nextUrl.searchParams)
  if (error) return NextResponse.json({ error }, { status: 400 })

  // ─── Scope check ───────────────────────────────────────────────────────────
  let anonymize = false

  if (!isAdmin) {
    // Non-instance-admin must supply a project_id they administer.
    if (!query.project_id) {
      return NextResponse.json(
        { error: 'Forbidden — supply project_id or use an instance_admin account' },
        { status: 403 },
      )
    }
    try {
      const perms = await resolvePermissions(caller, query.project_id)
      // admin:integrations is the distinguishing permission of the project-level admin role
      if (!perms.has('admin:integrations')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } catch (e) {
      if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // Project admins always get anonymized export (Am.85.10)
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
