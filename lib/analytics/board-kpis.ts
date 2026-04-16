// lib/analytics/board-kpis.ts
// Compute the 5 board KPIs with delta vs previous period (Amendment 85.6).

import type { AnalyticsSummary, BoardKPI } from './types'

// ─── Delta formatters ─────────────────────────────────────────────────────────

/** Format a relative delta as "+34%" or "-5%" or undefined if prev=0. */
function formatDelta(current: number, previous: number): string | undefined {
  if (previous === 0) return undefined
  const pct = ((current - previous) / previous) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(0)}%`
}

/** Format an absolute delta in percentage points: "+4pts" or "-2pts". */
function formatDeltaPts(current: number, previous: number): string | undefined {
  const diff = current - previous
  const sign = diff >= 0 ? '+' : ''
  return `${sign}${diff.toFixed(0)}pts`
}

// ─── Board KPIs ──────────────────────────────────────────────────────────────

/**
 * Compute the 5 board KPIs comparing current period vs previous period.
 * Returns KPIs in display order (runs, users, retention, quality, ROI).
 */
export function computeBoardKPIs(
  current:  AnalyticsSummary,
  previous: AnalyticsSummary,
  _config:  { hourly_rate_usd: number },
): BoardKPI[] {
  return [
    // 1 — Volume
    {
      id:        'runs_completed',
      label:     'Runs completed',
      value:     current.runs_completed.toLocaleString(),
      delta:     formatDelta(current.runs_completed, previous.runs_completed),
      trend:     current.runs_completed >= previous.runs_completed ? 'up' : 'down',
      good_when: 'up',
    },

    // 2 — Active users
    {
      id:        'active_users',
      label:     'Active users',
      value:     current.users_active.toString(),
      delta:     formatDelta(current.users_active, previous.users_active),
      trend:     current.users_active >= previous.users_active ? 'up' : 'down',
      good_when: 'up',
    },

    // 3 — User retention
    {
      id:        'retention',
      label:     'User retention',
      value:     `${current.retention_rate_pct.toFixed(0)}%`,
      delta:     formatDeltaPts(current.retention_rate_pct, previous.retention_rate_pct),
      trend:     current.retention_rate_pct >= previous.retention_rate_pct ? 'up' : 'down',
      good_when: 'up',
    },

    // 4 — Quality (direct approval rate)
    {
      id:        'quality',
      label:     'Direct approval rate',
      value:     `${current.approval_direct_rate_pct.toFixed(0)}%`,
      delta:     formatDeltaPts(current.approval_direct_rate_pct, previous.approval_direct_rate_pct),
      trend:     current.approval_direct_rate_pct >= previous.approval_direct_rate_pct ? 'up' : 'down',
      good_when: 'up',
    },

    // 5 — ROI
    {
      id:        'roi',
      label:     'Estimated ROI',
      value:     current.roi_multiplier
        ? `${current.roi_multiplier.toFixed(0)}×`
        : 'n/a (no hours data)',
      delta:     current.roi_multiplier != null && previous.roi_multiplier != null
        ? formatDelta(current.roi_multiplier, previous.roi_multiplier)
        : undefined,
      trend:     current.roi_multiplier != null && previous.roi_multiplier != null
        ? current.roi_multiplier >= previous.roi_multiplier ? 'up' : 'down'
        : 'neutral',
      good_when: 'up',
    },
  ]
}
