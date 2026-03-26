// lib/analytics/export.ts
// Export analytics data to JSON, CSV, or PDF (Amendment 85.9).
//
// PDF: generates print-optimized HTML. In production, a headless browser
// (Puppeteer/Playwright MCP skill) renders this to PDF. The route returns
// HTML with print-optimized @media print styles — clients print to PDF,
// or the server can invoke Puppeteer if available.
//
// CSV: flat format compatible with Excel, Google Sheets, Metabase.
// JSON: full AnalyticsResponse — default.

import type { AnalyticsResponse, AnalyticsSummary, BoardKPI } from './types'

// ─── JSON export ─────────────────────────────────────────────────────────────

export function toJson(data: AnalyticsResponse): string {
  return JSON.stringify(data, null, 2)
}

// ─── CSV export ──────────────────────────────────────────────────────────────

/**
 * Produce a flat CSV combining timeseries rows.
 * Schema: date, runs_completed, cost_usd, users_active, avg_rating
 *
 * Also appends a second section with summary KPIs separated by a blank row.
 */
export function toCsv(data: AnalyticsResponse): string {
  const rows: string[][] = []

  // Header
  rows.push(['section', 'date', 'runs_completed', 'cost_usd', 'users_active', 'avg_rating'])

  // Timeseries rows
  for (const pt of data.timeseries) {
    rows.push([
      'timeseries',
      pt.date,
      pt.runs_completed.toString(),
      pt.cost_usd.toFixed(4),
      pt.users_active.toString(),
      pt.avg_rating != null ? pt.avg_rating.toFixed(2) : '',
    ])
  }

  // Blank separator
  rows.push([])

  // Summary KPIs
  rows.push(['kpi', 'id', 'label', 'value', 'delta', 'trend', '', ''])
  for (const kpi of data.top_kpis) {
    rows.push(['kpi', kpi.id, kpi.label, kpi.value, kpi.delta ?? '', kpi.trend, '', ''])
  }

  // Blank separator
  rows.push([])

  // Profile breakdown
  rows.push(['by_profile', 'profile', 'runs', 'cost_usd', 'avg_duration_s', 'completion_rate', 'avg_rating', ''])
  for (const p of data.by_profile) {
    rows.push([
      'by_profile',
      p.profile,
      p.runs.toString(),
      p.cost_usd.toFixed(4),
      p.avg_duration_s.toFixed(0),
      (p.completion_rate * 100).toFixed(1) + '%',
      p.avg_rating != null ? p.avg_rating.toFixed(2) : '',
      '',
    ])
  }

  return rows
    .map(cols => cols.map(cell => csvEscape(cell)).join(','))
    .join('\r\n')
}

function csvEscape(value: string): string {
  // Escape only when necessary — values containing comma, quote, or newline
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

// ─── PDF (HTML) export ────────────────────────────────────────────────────────

/**
 * Produce a print-optimized HTML document representing the analytics summary.
 * Intended to be rendered to PDF by the caller (e.g. Puppeteer, browser print).
 *
 * The HTML is self-contained (no external CDN dependencies) with inline styles.
 * Print-specific styles via @media print ensure proper page breaks and margins.
 *
 * SECURITY: all values are HTML-escaped before insertion. No user-supplied
 * content reaches the template without escaping.
 */
export function toPdfHtml(data: AnalyticsResponse): string {
  const esc = htmlEscape

  const kpiCards = data.top_kpis.map(kpi => {
    const trendIcon = kpi.trend === 'up' ? '↑' : kpi.trend === 'down' ? '↓' : '–'
    const trendColor = kpi.trend === 'up' && kpi.good_when === 'up' ? '#16a34a'
      : kpi.trend === 'down' && kpi.good_when === 'down' ? '#16a34a'
      : kpi.trend === 'neutral' ? '#6b7280'
      : '#dc2626'
    return `
      <div class="kpi-card">
        <div class="kpi-label">${esc(kpi.label)}</div>
        <div class="kpi-value">${esc(kpi.value)}</div>
        ${kpi.delta ? `<div class="kpi-delta" style="color:${trendColor}">${esc(trendIcon)} ${esc(kpi.delta)}</div>` : ''}
      </div>`
  }).join('\n')

  const profileRows = data.by_profile.slice(0, 10).map(p =>
    `<tr>
      <td>${esc(p.profile)}</td>
      <td class="num">${p.runs}</td>
      <td class="num">$${p.cost_usd.toFixed(2)}</td>
      <td class="num">${formatDuration(p.avg_duration_s)}</td>
      <td class="num">${(p.completion_rate * 100).toFixed(0)}%</td>
      <td class="num">${p.avg_rating != null ? p.avg_rating.toFixed(1) + ' ★' : '—'}</td>
    </tr>`
  ).join('\n')

  const summaryRows = summaryTableRows(data.summary)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harmoven Analytics — ${esc(data.period.from.slice(0, 10))} to ${esc(data.period.to.slice(0, 10))}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 12px; color: #111; background: #fff; padding: 32px; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; color: #374151; }
  .period { color: #6b7280; font-size: 11px; margin-bottom: 24px; }
  .kpi-grid { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
  .kpi-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; min-width: 120px; flex: 1; }
  .kpi-label { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
  .kpi-value { font-size: 22px; font-weight: 700; margin: 4px 0; }
  .kpi-delta { font-size: 11px; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #f9fafb; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 8px; text-align: left; border-bottom: 1px solid #e5e7eb; }
  td { padding: 5px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .caveat { font-size: 10px; color: #9ca3af; margin-top: 16px; padding: 8px 12px; background: #f9fafb; border-radius: 4px; }
  @media print {
    body { padding: 16px; }
    page-break-inside: avoid;
    .kpi-grid { break-inside: avoid; }
    table { break-inside: avoid; }
  }
</style>
</head>
<body>
<h1>Harmoven Analytics</h1>
<p class="period">Period: ${esc(data.period.from.slice(0, 10))} → ${esc(data.period.to.slice(0, 10))} · Granularity: ${esc(data.granularity)}</p>

<h2>Key Performance Indicators</h2>
<div class="kpi-grid">
${kpiCards}
</div>

<h2>Summary</h2>
<table>
  <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
  <tbody>${summaryRows}</tbody>
</table>

<h2>By Profile</h2>
<table>
  <thead>
    <tr>
      <th>Profile</th>
      <th class="num">Runs</th>
      <th class="num">Cost</th>
      <th class="num">Avg Duration</th>
      <th class="num">Completion</th>
      <th class="num">Avg Rating</th>
    </tr>
  </thead>
  <tbody>${profileRows}</tbody>
</table>

<p class="caveat">
  ℹ ROI is estimated — based on ${data.summary.estimated_hours_saved_total != null ? 'available' : 'no'} hours data.
  This report was generated by Harmoven v1.
</p>
</body>
</html>`
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function htmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return `${mins}m${secs > 0 ? ` ${secs}s` : ''}`
}

function summaryTableRows(s: AnalyticsSummary): string {
  const rows: [string, string][] = [
    ['Total runs',               s.runs_total.toString()],
    ['Completed',                `${s.runs_completed} (${s.completion_rate_pct.toFixed(0)}%)`],
    ['Failed',                   s.runs_failed.toString()],
    ['Active users',             s.users_active.toString()],
    ['User retention',           `${s.retention_rate_pct.toFixed(0)}%`],
    ['Total cost',               `$${s.cost_total_usd.toFixed(2)}`],
    ['Cost per run',             `$${s.cost_per_run_usd.toFixed(2)}`],
    ['Direct approval rate',     `${s.approval_direct_rate_pct.toFixed(0)}%`],
    ['Avg user rating',          s.avg_user_rating != null ? s.avg_user_rating.toFixed(1) + ' ★' : 'n/a'],
    ['Estimated hours saved',    s.estimated_hours_saved_total != null ? `${s.estimated_hours_saved_total.toFixed(0)}h` : 'n/a'],
    ['Estimated value',          s.estimated_value_usd != null ? `$${s.estimated_value_usd.toFixed(0)}` : 'n/a'],
    ['ROI multiplier',           s.roi_multiplier != null ? `${s.roi_multiplier.toFixed(0)}×` : 'n/a'],
  ]
  return rows
    .map(([label, value]) =>
      `<tr><td>${htmlEscape(label)}</td><td class="num">${htmlEscape(value)}</td></tr>`
    )
    .join('\n')
}
