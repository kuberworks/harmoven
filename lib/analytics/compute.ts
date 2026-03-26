// lib/analytics/compute.ts
// Analytics computation engine — Amendment 85.
//
// Exports:
//   computeAnalyticsSummary()    — aggregate metrics for a time window
//   computeTimeseries()          — runs/cost/users by day|week|month
//   computeProfileBreakdown()    — metrics by domain_profile
//   computeUserBreakdown()       — per-user contributions
//   computeUserPeriodStats()     — cross-run, cross-project user aggregation
//   computePreviousPeriod()      — mirror query for the previous period (for delta)
//
// Security: callers must enforce permission checks before calling these functions.
// Parameterized DB queries only — no SQL injection surface.

import { db } from '@/lib/db/client'
import type {
  AnalyticsQuery,
  AnalyticsSummary,
  AnalyticsDataPoint,
  ProfileBreakdown,
  UserBreakdown,
  UserPeriodStats,
} from './types'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den
}

/** Build Prisma `where` clauses shared across analytics queries. */
function runWhere(q: AnalyticsQuery) {
  return {
    created_at: { gte: q.from, lte: q.to },
    ...(q.project_id ? { project_id: q.project_id } : {}),
  }
}

// ─── Summary computation ──────────────────────────────────────────────────────

export async function computeAnalyticsSummary(
  q: AnalyticsQuery,
  hourlyRateUsd: number,
): Promise<AnalyticsSummary> {
  const where = runWhere(q)

  // Fetch all completed runs in range (for cost aggregate)
  const runs = await db.run.findMany({
    where,
    select: {
      id: true,
      status: true,
      created_by: true,
      cost_actual_usd: true,
      user_rating: true,
      estimated_hours_saved: true,
    },
  })

  const total = runs.length
  const completed = runs.filter(r => r.status === 'COMPLETED').length
  const failed    = runs.filter(r => r.status === 'FAILED').length

  // Unique active users (created at least one run)
  const activeUserIds = new Set(runs.map(r => r.created_by).filter(Boolean) as string[])
  const usersActive = activeUserIds.size

  // Cost aggregation — cost_actual_usd is Decimal, convert to number safely
  const costTotal = runs.reduce((sum, r) => sum + Number(r.cost_actual_usd ?? 0), 0)

  // User rating
  const ratedRuns = runs.filter(r => r.user_rating != null)
  const avgRating = ratedRuns.length > 0
    ? ratedRuns.reduce((s, r) => s + (r.user_rating ?? 0), 0) / ratedRuns.length
    : null

  // Hours saved
  const runsWithHours = runs.filter(r => r.estimated_hours_saved != null && r.estimated_hours_saved > 0)
  const hoursSavedTotal = runsWithHours.length > 0
    ? runsWithHours.reduce((s, r) => s + (r.estimated_hours_saved ?? 0), 0)
    : null
  const estimatedValueUsd = hoursSavedTotal != null ? hoursSavedTotal * hourlyRateUsd : null
  const roiMultiplier = estimatedValueUsd != null && costTotal > 0
    ? estimatedValueUsd / costTotal
    : null

  // Human gate approval rate (approved without modification)
  const gates = await db.humanGate.findMany({
    where: {
      run: where,
      status: 'RESOLVED',
    },
    select: { decision: true },
  })
  const gateTotal  = gates.length
  const gateDirect = gates.filter(g => g.decision === 'approve').length
  const approvalDirectRate = safeDiv(gateDirect, gateTotal) * 100

  // Critical findings average
  const critResults = await (db as any).criticalReviewResult?.findMany?.({
    where: { run: where },
    select: { findings: true },
  }).catch(() => []) as Array<{ findings: unknown }> ?? []
  const avgCritical = critResults.length > 0
    ? critResults.reduce((s: number, r: { findings: unknown }) => {
        const arr = Array.isArray(r.findings) ? r.findings : []
        return s + arr.length
      }, 0) / critResults.length
    : 0

  // Retention: users active in both previous period AND current period
  const prevFrom = new Date(q.from.getTime() - (q.to.getTime() - q.from.getTime()))
  const prevRuns = await db.run.findMany({
    where: {
      created_at: { gte: prevFrom, lt: q.from },
      ...(q.project_id ? { project_id: q.project_id } : {}),
    },
    select: { created_by: true },
  })
  const prevActiveIds = new Set(prevRuns.map(r => r.created_by).filter(Boolean) as string[])
  let retained = 0
  for (const uid of activeUserIds) {
    if (prevActiveIds.has(uid)) retained++
  }
  const retentionRatePct = prevActiveIds.size > 0
    ? safeDiv(retained, prevActiveIds.size) * 100
    : 0

  return {
    runs_total: total,
    runs_completed: completed,
    runs_failed: failed,
    completion_rate_pct: safeDiv(completed, total) * 100,
    users_active: usersActive,
    users_retained: retained,
    retention_rate_pct: retentionRatePct,
    cost_total_usd: costTotal,
    cost_per_run_usd: safeDiv(costTotal, total),
    cost_per_active_user_usd: safeDiv(costTotal, usersActive),
    approval_direct_rate_pct: approvalDirectRate,
    avg_critical_findings: avgCritical,
    avg_user_rating: avgRating,
    estimated_hours_saved_total: hoursSavedTotal,
    estimated_value_usd: estimatedValueUsd,
    roi_multiplier: roiMultiplier,
  }
}

// ─── Timeseries computation ───────────────────────────────────────────────────

/**
 * Group runs by period bucket (day/week/month) and aggregate
 * runs_completed, cost_usd, users_active, avg_rating per bucket.
 */
export async function computeTimeseries(
  q: AnalyticsQuery,
): Promise<AnalyticsDataPoint[]> {
  const runs = await db.run.findMany({
    where: runWhere(q),
    select: {
      status: true,
      created_by: true,
      created_at: true,
      cost_actual_usd: true,
      user_rating: true,
    },
    orderBy: { created_at: 'asc' },
  })

  const granularity = q.granularity ?? 'week'

  function bucketKey(date: Date): string {
    const d = new Date(date)
    if (granularity === 'day') {
      return d.toISOString().slice(0, 10)
    } else if (granularity === 'month') {
      return d.toISOString().slice(0, 7) + '-01'
    } else {
      // week — round down to Monday
      const day = d.getUTCDay()
      const diff = (day === 0 ? -6 : 1 - day)
      d.setUTCDate(d.getUTCDate() + diff)
      return d.toISOString().slice(0, 10)
    }
  }

  const buckets = new Map<string, {
    runs_completed: number
    cost_usd: number
    user_ids: Set<string>
    ratings: number[]
  }>()

  for (const run of runs) {
    const key = bucketKey(run.created_at)
    if (!buckets.has(key)) {
      buckets.set(key, { runs_completed: 0, cost_usd: 0, user_ids: new Set(), ratings: [] })
    }
    const b = buckets.get(key)!
    if (run.status === 'COMPLETED') b.runs_completed++
    b.cost_usd += Number(run.cost_actual_usd ?? 0)
    if (run.created_by) b.user_ids.add(run.created_by)
    if (run.user_rating != null) b.ratings.push(run.user_rating)
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, b]) => ({
      date,
      runs_completed: b.runs_completed,
      cost_usd: b.cost_usd,
      users_active: b.user_ids.size,
      avg_rating: b.ratings.length > 0
        ? b.ratings.reduce((s, v) => s + v, 0) / b.ratings.length
        : null,
    }))
}

// ─── Profile breakdown ───────────────────────────────────────────────────────

export async function computeProfileBreakdown(
  q: AnalyticsQuery,
): Promise<ProfileBreakdown[]> {
  const runs = await db.run.findMany({
    where: runWhere(q),
    select: {
      domain_profile: true,
      status: true,
      cost_actual_usd: true,
      user_rating: true,
      started_at: true,
      completed_at: true,
    },
  })

  const profiles = new Map<string, {
    total: number
    completed: number
    cost: number
    durations: number[]
    ratings: number[]
  }>()

  for (const run of runs) {
    const key = run.domain_profile ?? 'other'
    if (!profiles.has(key)) {
      profiles.set(key, { total: 0, completed: 0, cost: 0, durations: [], ratings: [] })
    }
    const p = profiles.get(key)!
    p.total++
    if (run.status === 'COMPLETED') p.completed++
    p.cost += Number(run.cost_actual_usd ?? 0)
    if (run.started_at && run.completed_at) {
      p.durations.push((run.completed_at.getTime() - run.started_at.getTime()) / 1000)
    }
    if (run.user_rating != null) p.ratings.push(run.user_rating)
  }

  return [...profiles.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([profile, p]) => ({
      profile,
      runs: p.total,
      cost_usd: p.cost,
      avg_duration_s: p.durations.length > 0
        ? p.durations.reduce((s, v) => s + v, 0) / p.durations.length
        : 0,
      completion_rate: safeDiv(p.completed, p.total),
      avg_rating: p.ratings.length > 0
        ? p.ratings.reduce((s, v) => s + v, 0) / p.ratings.length
        : null,
    }))
}

// ─── User breakdown ──────────────────────────────────────────────────────────

export async function computeUserBreakdown(
  q: AnalyticsQuery,
  anonymize: boolean,
): Promise<UserBreakdown[]> {
  const runs = await db.run.findMany({
    where: runWhere(q),
    select: {
      created_by: true,
      user_rating: true,
      estimated_hours_saved: true,
      actor_stats: { select: { stats: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  })

  // Aggregate per user
  const users = new Map<string, {
    display_name: string
    runs: number
    contribution_pcts: number[]
    ratings: number[]
    hours_saved: number
    hours_known: boolean
  }>()

  for (const run of runs) {
    if (!run.created_by) continue
    const uid = run.created_by
    if (!users.has(uid)) {
      users.set(uid, {
        display_name: run.user?.name ?? run.user?.email ?? uid,
        runs: 0,
        contribution_pcts: [],
        ratings: [],
        hours_saved: 0,
        hours_known: false,
      })
    }
    const u = users.get(uid)!
    u.runs++
    if (run.user_rating != null) u.ratings.push(run.user_rating)
    if (run.estimated_hours_saved != null) {
      u.hours_saved += run.estimated_hours_saved
      u.hours_known = true
    }
    // Extract contribution pct from RunActorStats if cached
    if (run.actor_stats?.stats) {
      const stats = run.actor_stats.stats as { actors?: Array<{ user_id?: string; contribution_pct?: number }> }
      const actor = stats.actors?.find(a => a.user_id === uid)
      if (actor?.contribution_pct != null) {
        u.contribution_pcts.push(actor.contribution_pct)
      }
    }
  }

  // Anonymize if requested (shuffle order, use labels A/B/C…)
  const entries = [...users.entries()]
  if (anonymize) {
    // Fisher-Yates shuffle for stable-per-export anonymization
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = entries[i]!
      entries[i] = entries[j]!
      entries[j] = tmp
    }
  }

  return entries.map(([uid, u], idx) => ({
    user_id: anonymize ? `anon-${idx}` : uid,
    display_name: anonymize ? `User ${String.fromCharCode(65 + (idx % 26))}` : u.display_name,
    runs_authored: u.runs,
    avg_contribution_pct: u.contribution_pcts.length > 0
      ? u.contribution_pcts.reduce((s, v) => s + v, 0) / u.contribution_pcts.length
      : 0,
    avg_rating: u.ratings.length > 0
      ? u.ratings.reduce((s, v) => s + v, 0) / u.ratings.length
      : null,
    hours_saved: u.hours_known ? u.hours_saved : null,
  })).sort((a, b) => b.runs_authored - a.runs_authored)
}

// ─── User period stats (Am.85.4) ─────────────────────────────────────────────

export interface UserStatsQuery {
  user_id: string
  project_ids?: string[] | null
  from: Date
  to: Date
}

export async function computeUserPeriodStats(
  query: UserStatsQuery,
): Promise<UserPeriodStats> {
  const { user_id, project_ids, from, to } = query

  const projectFilter = project_ids ? { project_id: { in: project_ids } } : {}
  const dateFilter    = { created_at: { gte: from, lte: to } }

  // Runs authored by this user in the period (COMPLETED only for ROI metrics)
  const authoredRuns = await db.run.findMany({
    where: {
      created_by: user_id,
      ...dateFilter,
      ...projectFilter,
    },
    select: {
      id: true,
      user_rating: true,
      estimated_hours_saved: true,
      project_id: true,
    },
  })

  // Runs participated by this user (audit log entries)
  const auditParticipated = await db.auditLog.findMany({
    where: {
      actor: user_id,
      timestamp: { gte: from, lte: to },
      run: projectFilter.project_id ? { project_id: projectFilter.project_id } : undefined,
    },
    select: { run_id: true },
    distinct: ['run_id'],
  })

  const participatedRunIds = new Set([
    ...authoredRuns.map(r => r.id),
    ...auditParticipated.map(e => e.run_id).filter(Boolean) as string[],
  ])

  // Active projects
  const activeProjects = new Set([
    ...authoredRuns.map(r => r.project_id),
  ])

  // Human gates decided by this user
  const gatesDecided = await db.humanGate.findMany({
    where: {
      decided_by: user_id,
      decided_at: { gte: from, lte: to },
      ...(project_ids ? { run: { project_id: { in: project_ids } } } : {}),
    },
    select: { decision: true },
  })

  const gatesDirect   = gatesDecided.filter(g => g.decision === 'approve').length
  const gatesModified = gatesDecided.filter(g => g.decision === 'modify').length

  // Context injections by this user
  const contextInjections = await db.auditLog.count({
    where: {
      actor: user_id,
      action_type: 'context_injected',
      timestamp: { gte: from, lte: to },
    },
  })

  // Quality metrics from authored runs
  const ratedRuns = authoredRuns.filter(r => r.user_rating != null)
  const avgRating = ratedRuns.length > 0
    ? ratedRuns.reduce((s, r) => s + (r.user_rating ?? 0), 0) / ratedRuns.length
    : null

  const runsWithHours = authoredRuns.filter(r => r.estimated_hours_saved != null && r.estimated_hours_saved > 0)
  const hoursSaved = runsWithHours.length > 0
    ? runsWithHours.reduce((s, r) => s + (r.estimated_hours_saved ?? 0), 0)
    : null

  // Contribution weights from cached RunActorStats
  const actorStatsRows = await db.runActorStats.findMany({
    where: {
      run: {
        OR: [
          { created_by: user_id },
          { human_gates: { some: { decided_by: user_id } } },
        ],
        created_at: { gte: from, lte: to },
        ...(project_ids ? { project_id: { in: project_ids } } : {}),
      },
    },
    select: { stats: true },
  })

  let totalWeight = 0
  const contributionPcts: number[] = []
  const byType = {
    task_authoring:   { count: 0, weight: 0 },
    gate_decision:    { count: 0, weight: 0 },
    context_injection:{ count: 0, weight: 0 },
    node_authoring:   { count: 0, weight: 0 },
    other:            { count: 0, weight: 0 },
  }

  for (const row of actorStatsRows) {
    const stats = row.stats as { actors?: Array<{ user_id?: string; contribution_pct?: number; total_weight?: number; work_units?: Array<{ type: string; weight: number }> }> }
    const actor = stats.actors?.find(a => a.user_id === user_id)
    if (!actor) continue
    if (actor.contribution_pct != null) contributionPcts.push(actor.contribution_pct)
    if (actor.total_weight != null) totalWeight += actor.total_weight
    for (const unit of actor.work_units ?? []) {
      const type = (unit.type in byType ? unit.type : 'other') as keyof typeof byType
      byType[type].count++
      byType[type].weight += unit.weight
    }
  }

  return {
    user_id,
    period: { from, to },
    runs_authored: authoredRuns.length,
    runs_participated: participatedRunIds.size,
    projects_active: activeProjects.size,
    total_weight: totalWeight,
    avg_contribution_pct: contributionPcts.length > 0
      ? contributionPcts.reduce((s, v) => s + v, 0) / contributionPcts.length
      : 0,
    contribution_by_type: byType,
    gates_decided: gatesDecided.length,
    gates_approved_direct: gatesDirect,
    gates_modified: gatesModified,
    critical_findings_fixed: 0,    // requires CriticalFindingFix model query — deferred
    critical_findings_ignored: 0,
    context_injections: contextInjections,
    runs_rated: ratedRuns.length,
    avg_rating: avgRating,
    estimated_hours_saved_total: hoursSaved,
    runs_with_hours_data: runsWithHours.length,
  }
}

// ─── Previous period helper ────────────────────────────────────────────────────

/**
 * Build a query for the previous period (same duration, directly before `from`).
 * Used to compute delta values for board KPIs.
 */
export function previousPeriodQuery(q: AnalyticsQuery): AnalyticsQuery {
  const duration = q.to.getTime() - q.from.getTime()
  return {
    ...q,
    from: new Date(q.from.getTime() - duration),
    to:   new Date(q.from.getTime()),
  }
}
