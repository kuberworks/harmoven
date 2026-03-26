// tests/analytics/t3.4-analytics.test.ts
// Unit tests for T3.4 — Analytics dashboard (Amendment 85).
//
// Validates:
//   1. computeBoardKPIs() — 5 KPIs with correct delta/trend
//   2. toJson() / toCsv() — export format correctness
//   3. parseAnalyticsQuery() — validation, date range guard, defaults
//   4. computeUserPeriodStats() — cross-run aggregation with DB mock
//   5. getAnalyticsConfig() defaults
//
// All DB calls are mocked; no network or database required.

import { computeBoardKPIs } from '@/lib/analytics/board-kpis'
import { toJson, toCsv } from '@/lib/analytics/export'
import { parseAnalyticsQuery } from '@/lib/analytics/handler'
import type { AnalyticsSummary, AnalyticsResponse, BoardKPI } from '@/lib/analytics/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<AnalyticsSummary> = {}): AnalyticsSummary {
  return {
    runs_total:                        100,
    runs_completed:                     80,
    runs_failed:                          5,
    completion_rate_pct:                 80,
    users_active:                        20,
    users_retained:                      14,
    retention_rate_pct:                  70,
    cost_total_usd:                    1000,
    cost_per_run_usd:                    12.5,
    cost_per_active_user_usd:            50,
    approval_direct_rate_pct:            85,
    avg_critical_findings:                1,
    avg_user_rating:                      4.2,
    estimated_hours_saved_total:        160,
    estimated_value_usd:              12000,
    roi_multiplier:                      12,
    ...overrides,
  }
}

function makeResponse(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return {
    period:      { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
    granularity: 'week',
    summary:     makeSummary(),
    timeseries:  [
      { date: '2026-01-01', runs_completed: 20, cost_usd: 250, users_active: 10, avg_rating: 4.0 },
      { date: '2026-01-08', runs_completed: 30, cost_usd: 375, users_active: 12, avg_rating: 4.3 },
    ],
    by_profile: [
      { profile: 'coding',   runs: 50, cost_usd: 600, avg_duration_s: 3000, completion_rate: 80, avg_rating: 4.5 },
      { profile: 'analysis', runs: 30, cost_usd: 400, avg_duration_s: 4500, completion_rate: 75, avg_rating: 4.0 },
    ],
    by_user:  [],
    top_kpis: [],
    ...overrides,
  }
}

// ─── 1. computeBoardKPIs ──────────────────────────────────────────────────────

describe('computeBoardKPIs', () => {
  it('produces exactly 5 KPIs in order', () => {
    const kpis = computeBoardKPIs(makeSummary(), makeSummary(), { hourly_rate_usd: 75 })
    expect(kpis).toHaveLength(5)
    const ids = kpis.map(k => k.id)
    expect(ids).toEqual(['runs_completed', 'active_users', 'retention', 'quality', 'roi'])
  })

  it('shows upward trend when current > previous', () => {
    const current  = makeSummary({ runs_completed: 100, users_active: 25, retention_rate_pct: 75 })
    const previous = makeSummary({ runs_completed:  80, users_active: 20, retention_rate_pct: 70 })
    const kpis = computeBoardKPIs(current, previous, { hourly_rate_usd: 75 })

    const volume = kpis.find(k => k.id === 'runs_completed')!
    expect(volume.trend).toBe('up')
    expect(volume.delta).toBe('+25%')

    const users = kpis.find(k => k.id === 'active_users')!
    expect(users.trend).toBe('up')
    expect(users.delta).toBe('+25%')
  })

  it('shows downward trend when current < previous', () => {
    const current  = makeSummary({ runs_completed: 60 })
    const previous = makeSummary({ runs_completed: 80 })
    const kpis = computeBoardKPIs(current, previous, { hourly_rate_usd: 75 })

    const volume = kpis.find(k => k.id === 'runs_completed')!
    expect(volume.trend).toBe('down')
    expect(volume.delta).toBe('-25%')
  })

  it('returns undefined delta when previous = 0 (no prior runs)', () => {
    const current  = makeSummary({ runs_completed: 10 })
    const previous = makeSummary({ runs_completed: 0 })
    const kpis = computeBoardKPIs(current, previous, { hourly_rate_usd: 75 })

    const volume = kpis.find(k => k.id === 'runs_completed')!
    expect(volume.delta).toBeUndefined()
  })

  it('returns n/a ROI label when roi_multiplier is null', () => {
    const current  = makeSummary({ roi_multiplier: null })
    const previous = makeSummary({ roi_multiplier: null })
    const kpis = computeBoardKPIs(current, previous, { hourly_rate_usd: 75 })

    const roi = kpis.find(k => k.id === 'roi')!
    expect(roi.value).toBe('n/a (no hours data)')
    expect(roi.trend).toBe('neutral')
    expect(roi.delta).toBeUndefined()
  })

  it('formats retention delta in absolute percentage points', () => {
    const current  = makeSummary({ retention_rate_pct: 75 })
    const previous = makeSummary({ retention_rate_pct: 70 })
    const kpis = computeBoardKPIs(current, previous, { hourly_rate_usd: 75 })

    const retention = kpis.find(k => k.id === 'retention')!
    expect(retention.value).toBe('75%')
    expect(retention.delta).toBe('+5pts')
    expect(retention.trend).toBe('up')
  })
})

// ─── 2. Export functions ──────────────────────────────────────────────────────

describe('toJson', () => {
  it('serialises and parses round-trip correctly', () => {
    const data = makeResponse()
    const json = toJson(data)
    const parsed = JSON.parse(json) as AnalyticsResponse
    expect(parsed.granularity).toBe('week')
    expect(parsed.timeseries).toHaveLength(2)
  })

  it('output is indented (2 spaces)', () => {
    const data = makeResponse()
    const json = toJson(data)
    // JSON.stringify with 2-space indent produces lines starting with spaces
    expect(json).toContain('\n  ')
  })
})

describe('toCsv', () => {
  it('includes header row with expected columns', () => {
    const csv = toCsv(makeResponse())
    const firstLine = csv.split('\n')[0]
    expect(firstLine).toContain('section')
    expect(firstLine).toContain('date')
    expect(firstLine).toContain('runs_completed')
    expect(firstLine).toContain('cost_usd')
  })

  it('includes timeseries rows with correct values', () => {
    const csv = toCsv(makeResponse())
    expect(csv).toContain('timeseries')
    expect(csv).toContain('2026-01-01')
    expect(csv).toContain('20')
  })

  it('includes kpi section', () => {
    const data = makeResponse({
      top_kpis: [
        { id: 'runs_completed', label: 'Runs completed', value: '80', delta: '+10%', trend: 'up', good_when: 'up' },
      ],
    })
    const csv = toCsv(data)
    expect(csv).toContain('kpi')
    expect(csv).toContain('runs_completed')
  })

  it('escapes commas in string fields', () => {
    // build data with a profile that has a comma in name (edge case)
    const data = makeResponse({
      by_profile: [{ profile: 'coding, advanced', runs: 10, cost_usd: 100, avg_duration_s: 1800, completion_rate: 90, avg_rating: 4.5 }],
    })
    const csv = toCsv(data)
    // The profile string with comma must be quoted
    expect(csv).toContain('"coding, advanced"')
  })

  it('handles null avg_rating without NaN output', () => {
    const data = makeResponse({
      timeseries: [{ date: '2026-01-01', runs_completed: 5, cost_usd: 50, users_active: 3, avg_rating: null }],
    })
    const csv = toCsv(data)
    // null rating → empty string in CSV, not "null" or "NaN"
    expect(csv).not.toContain('null')
    expect(csv).not.toContain('NaN')
  })
})

// ─── 3. parseAnalyticsQuery ───────────────────────────────────────────────────

describe('parseAnalyticsQuery', () => {
  function makeParams(overrides: Record<string, string>) {
    return new URLSearchParams(overrides)
  }

  it('returns error when from/to are missing', () => {
    const result = parseAnalyticsQuery(makeParams({}))
    expect(result.error).toBeDefined()
  })

  it('returns error when from >= to', () => {
    const result = parseAnalyticsQuery(makeParams({ from: '2026-01-31', to: '2026-01-01' }))
    expect(result.error).toMatch(/from must be before to/)
  })

  it('returns error for invalid date strings', () => {
    const result = parseAnalyticsQuery(makeParams({ from: 'not-a-date', to: '2026-01-31' }))
    expect(result.error).toMatch(/Invalid date/)
  })

  it('rejects date range > 2 years', () => {
    const result = parseAnalyticsQuery(makeParams({ from: '2020-01-01', to: '2026-01-01' }))
    expect(result.error).toMatch(/exceeds maximum/)
  })

  it('defaults granularity to week when invalid value provided', () => {
    const result = parseAnalyticsQuery(makeParams({ from: '2026-01-01', to: '2026-02-01', granularity: 'quarter' }))
    expect(result.error).toBeUndefined()
    expect(result.query.granularity).toBe('week')
  })

  it('accepts valid granularities: day, week, month', () => {
    for (const gran of ['day', 'week', 'month'] as const) {
      const result = parseAnalyticsQuery(makeParams({ from: '2026-01-01', to: '2026-02-01', granularity: gran }))
      expect(result.error).toBeUndefined()
      expect(result.query.granularity).toBe(gran)
    }
  })

  it('defaults format to json when omitted', () => {
    const result = parseAnalyticsQuery(makeParams({ from: '2026-01-01', to: '2026-02-01' }))
    expect(result.format).toBe('json')
  })

  it('accepts format=csv and format=pdf', () => {
    for (const fmt of ['csv', 'pdf'] as const) {
      const result = parseAnalyticsQuery(makeParams({ from: '2026-01-01', to: '2026-02-01', format: fmt }))
      expect(result.format).toBe(fmt)
    }
  })

  it('passes project_id into the query object', () => {
    const result = parseAnalyticsQuery(makeParams({ from: '2026-01-01', to: '2026-02-01', project_id: 'proj-abc' }))
    expect(result.query.project_id).toBe('proj-abc')
  })
})

// ─── 4. getAnalyticsConfig defaults ──────────────────────────────────────────

describe('getAnalyticsConfig', () => {
  beforeEach(() => {
    jest.resetModules()
    // Use the test cache reset exported by the module
    const { _resetAnalyticsConfigCache } = require('@/lib/analytics/config')
    _resetAnalyticsConfigCache()
  })

  it('returns sensible defaults when orchestrator.yaml has no analytics section', () => {
    jest.mock('js-yaml', () => ({
      load: () => ({}), // no analytics section
    }))
    jest.mock('node:fs', () => ({
      readFileSync: () => 'placeholder',
    }))
    const { getAnalyticsConfig } = require('@/lib/analytics/config')
    const cfg = getAnalyticsConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.hourly_rate_usd).toBe(75)
    expect(cfg.anonymize_exports).toBe(false)
    expect(cfg.retention_days).toBe(365)
  })
})

// ─── 5. computeUserPeriodStats (with DB mock) ─────────────────────────────────

jest.mock('@/lib/db/client', () => ({
  db: {
    run: {
      findMany: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn(),
      count:    jest.fn(),
    },
    humanGate: {
      findMany: jest.fn(),
    },
    runActorStats: {
      findMany: jest.fn(),
    },
  },
}))

import { db } from '@/lib/db/client'
import { computeUserPeriodStats } from '@/lib/analytics/compute'

const mockDb = db as unknown as {
  run:          { findMany: jest.Mock }
  auditLog:     { findMany: jest.Mock; count: jest.Mock }
  humanGate:    { findMany: jest.Mock }
  runActorStats:{ findMany: jest.Mock }
}

describe('computeUserPeriodStats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns zero counts when user has no runs in range', async () => {
    mockDb.run.findMany.mockResolvedValueOnce([])
    mockDb.auditLog.findMany.mockResolvedValueOnce([])
    mockDb.humanGate.findMany.mockResolvedValueOnce([])
    mockDb.auditLog.count.mockResolvedValueOnce(0)
    mockDb.runActorStats.findMany.mockResolvedValueOnce([])

    const result = await computeUserPeriodStats({
      user_id: 'user-1',
      from:    new Date('2026-01-01'),
      to:      new Date('2026-01-31'),
    })
    expect(result.runs_authored).toBe(0)
    expect(result.runs_participated).toBe(0)
    expect(result.projects_active).toBe(0)
    expect(result.avg_rating).toBeNull()
    expect(result.estimated_hours_saved_total).toBeNull()
  })

  it('aggregates runs authored, gate decisions, and hours saved', async () => {
    mockDb.run.findMany.mockResolvedValueOnce([
      { id: 'r1', project_id: 'proj-1', user_rating: 5, estimated_hours_saved: 2 },
      { id: 'r2', project_id: 'proj-1', user_rating: 4, estimated_hours_saved: 1 },
      { id: 'r3', project_id: 'proj-2', user_rating: null, estimated_hours_saved: null },
    ])
    mockDb.auditLog.findMany.mockResolvedValueOnce([])
    mockDb.humanGate.findMany.mockResolvedValueOnce([
      { decision: 'approve' },
      { decision: 'modify' },
    ])
    mockDb.auditLog.count.mockResolvedValueOnce(1)
    mockDb.runActorStats.findMany.mockResolvedValueOnce([])

    const result = await computeUserPeriodStats({
      user_id: 'user-1',
      from:    new Date('2026-01-01'),
      to:      new Date('2026-01-31'),
    })

    expect(result.runs_authored).toBe(3)
    expect(result.projects_active).toBe(2)
    expect(result.gates_decided).toBe(2)
    expect(result.gates_approved_direct).toBe(1)
    expect(result.gates_modified).toBe(1)
    expect(result.estimated_hours_saved_total).toBe(3)
    expect(result.avg_rating).toBeCloseTo(4.5)  // (5+4)/2
    expect(result.context_injections).toBe(1)
  })
})
