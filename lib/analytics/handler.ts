// lib/analytics/handler.ts
// Shared handler logic for GET /api/analytics and GET /api/v1/analytics.
// Both routes call this after their own auth/permission checks.
//
// Security contract (enforced by callers):
//   - Caller must have admin:audit permission before calling buildAnalyticsResponse()
//   - project_id scoping is applied when caller lacks admin:audit (project admin case)
//
// This module is pure computation — no auth checks.

import {
  computeAnalyticsSummary,
  computeTimeseries,
  computeProfileBreakdown,
  computeUserBreakdown,
  previousPeriodQuery,
} from './compute'
import { computeBoardKPIs } from './board-kpis'
import type { AnalyticsQuery, AnalyticsResponse } from './types'
import type { AnalyticsConfig } from './config'

export interface AnalyticsHandlerOptions {
  query: AnalyticsQuery
  config: AnalyticsConfig
  anonymize: boolean   // override from caller — true for project-admin without admin:audit
}

export async function buildAnalyticsResponse(
  opts: AnalyticsHandlerOptions,
): Promise<AnalyticsResponse> {
  const { query, config, anonymize } = opts

  // Run both current and previous periods in parallel
  const prevQuery = previousPeriodQuery(query)

  const [summary, prevSummary, timeseries, byProfile, byUser] = await Promise.all([
    computeAnalyticsSummary(query, config.hourly_rate_usd),
    computeAnalyticsSummary(prevQuery, config.hourly_rate_usd),
    computeTimeseries(query),
    computeProfileBreakdown(query),
    computeUserBreakdown(query, anonymize || config.anonymize_exports),
  ])

  const topKpis = computeBoardKPIs(summary, prevSummary, { hourly_rate_usd: config.hourly_rate_usd })

  return {
    period:      { from: query.from.toISOString(), to: query.to.toISOString() },
    granularity: query.granularity ?? 'week',
    summary,
    timeseries,
    by_profile: byProfile,
    by_user:    byUser,
    top_kpis:   topKpis,
  }
}

// ─── Query parsing ────────────────────────────────────────────────────────────

const VALID_GRANULARITIES = ['day', 'week', 'month'] as const
const MAX_RANGE_DAYS = 366 * 2  // 2 years maximum

export interface ParsedAnalyticsQuery {
  query: AnalyticsQuery
  format: 'json' | 'csv' | 'pdf'
  error?: string
}

/**
 * Parse and validate analytics query parameters from a URLSearchParams object.
 * Returns an error string if validation fails (caller should return 400).
 */
export function parseAnalyticsQuery(params: URLSearchParams): ParsedAnalyticsQuery {
  const fromStr = params.get('from')
  const toStr   = params.get('to')

  if (!fromStr || !toStr) {
    return { query: {} as AnalyticsQuery, format: 'json', error: 'Missing required parameters: from, to' }
  }

  const from = new Date(fromStr)
  const to   = new Date(toStr)

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return { query: {} as AnalyticsQuery, format: 'json', error: 'Invalid date format — use ISO 8601 (e.g. 2026-01-01)' }
  }

  if (from >= to) {
    return { query: {} as AnalyticsQuery, format: 'json', error: 'from must be before to' }
  }

  const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)
  if (rangeDays > MAX_RANGE_DAYS) {
    return { query: {} as AnalyticsQuery, format: 'json', error: `Date range exceeds maximum of ${MAX_RANGE_DAYS} days` }
  }

  const granularityParam = params.get('granularity')
  const granularity = VALID_GRANULARITIES.includes(granularityParam as typeof VALID_GRANULARITIES[number])
    ? granularityParam as typeof VALID_GRANULARITIES[number]
    : 'week'

  const projectId = params.get('project_id') ?? undefined

  const formatParam = params.get('format') ?? 'json'
  const format: 'json' | 'csv' | 'pdf' = (['json', 'csv', 'pdf'] as const).includes(formatParam as 'json' | 'csv' | 'pdf')
    ? formatParam as 'json' | 'csv' | 'pdf'
    : 'json'

  return {
    query: { from, to, project_id: projectId, granularity },
    format,
  }
}
