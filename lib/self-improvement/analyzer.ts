// lib/self-improvement/analyzer.ts
// Computes InstanceMetrics by querying local Postgres via Prisma.
// Only reads aggregate/numeric fields — no user content, no personal data.
// Called by runner.ts on each analysis cycle.

import { db } from '@/lib/db/client'
import type {
  SelfImprovementConfig,
  InstanceMetrics,
  ProfileNodeStat,
  ProfileEvalStat,
  ProjectBudgetStat,
  GateFrequencyStat,
} from './types'

export async function computeInstanceMetrics(
  cfg: SelfImprovementConfig,
): Promise<InstanceMetrics> {
  const to   = new Date()
  const from = new Date(to.getTime() - cfg.lookback_days * 86_400_000)

  const [profileNodeStats, profileEvalStats, projectBudgetStats, gateStats] =
    await Promise.all([
      computeProfileNodeStats(from, to),
      computeProfileEvalStats(from, to),
      computeProjectBudgetStats(from, to),
      computeGateStats(from, to),
    ])

  return {
    profileNodeStats,
    profileEvalStats,
    projectBudgetStats,
    gateFrequencyStats: gateStats.frequency,
    gateAbandonedCount: gateStats.abandoned,
    from,
    to,
  }
}

// ─── Profile / node error + retry stats ──────────────────────────────────────

async function computeProfileNodeStats(
  from: Date,
  to: Date,
): Promise<ProfileNodeStat[]> {
  const rows = await db.node.findMany({
    where: {
      run: { created_at: { gte: from, lte: to } },
      llm_profile_id: { not: null },
    },
    select: {
      llm_profile_id: true,
      agent_type:     true,
      status:         true,
      retries:        true,
    },
  })

  // Aggregate in memory — avoids $queryRaw and complex GROUP BY
  const buckets = new Map<string, { total: number; errors: number; retries: number }>()

  for (const row of rows) {
    const key = `${row.llm_profile_id}::${row.agent_type}`
    const b   = buckets.get(key) ?? { total: 0, errors: 0, retries: 0 }
    b.total++
    if (row.status === 'FAILED')  b.errors++
    b.retries += row.retries
    buckets.set(key, b)
  }

  const result: ProfileNodeStat[] = []
  for (const [key, b] of buckets) {
    const [llm_profile_id, agent_type] = key.split('::')
    result.push({
      llm_profile_id: llm_profile_id!,
      agent_type:     agent_type!,
      total:          b.total,
      errors:         b.errors,
      retries_sum:    b.retries,
      avg_retries:    b.total > 0 ? b.retries / b.total : 0,
      error_rate:     b.total > 0 ? b.errors / b.total : 0,
    })
  }
  return result
}

// ─── Eval score / rejection stats ────────────────────────────────────────────

async function computeProfileEvalStats(
  from: Date,
  to: Date,
): Promise<ProfileEvalStat[]> {
  const rows = await db.evalResult.findMany({
    where: {
      run: { created_at: { gte: from, lte: to } },
    },
    select: {
      overall_score: true,
      passed:        true,
      // Join the node to get the llm_profile_id used
      node_id: true,
      run_id:  true,
    },
  })

  // Also fetch node llm_profile_id for the evaluated nodes
  const runNodePairs = rows.map(r => ({ run_id: r.run_id, node_id: r.node_id }))
  const nodes = runNodePairs.length > 0
    ? await db.node.findMany({
        where: {
          OR: runNodePairs.map(p => ({ run_id: p.run_id, node_id: p.node_id })),
        },
        select: { run_id: true, node_id: true, llm_profile_id: true },
      })
    : []

  const nodeKey = (run_id: string, node_id: string) => `${run_id}::${node_id}`
  const nodeMap = new Map(nodes.map(n => [nodeKey(n.run_id, n.node_id), n.llm_profile_id ?? 'unknown']))

  const buckets = new Map<string, { scores: number[]; failures: number }>()

  for (const row of rows) {
    const profileId = nodeMap.get(nodeKey(row.run_id, row.node_id)) ?? 'unknown'
    const b = buckets.get(profileId) ?? { scores: [], failures: 0 }
    b.scores.push(row.overall_score)
    if (!row.passed) b.failures++
    buckets.set(profileId, b)
  }

  const result: ProfileEvalStat[] = []
  for (const [llm_used, b] of buckets) {
    const total     = b.scores.length
    const avg_score = total > 0
      ? b.scores.reduce((a, v) => a + v, 0) / total
      : 0
    result.push({
      llm_used,
      total_evals:    total,
      avg_score,
      rejection_rate: total > 0 ? b.failures / total : 0,
    })
  }
  return result
}

// ─── Budget overshoot stats ───────────────────────────────────────────────────

async function computeProjectBudgetStats(
  from: Date,
  to: Date,
): Promise<ProjectBudgetStat[]> {
  const runs = await db.run.findMany({
    where: {
      created_at:  { gte: from, lte: to },
      budget_usd:  { not: null },
    },
    select: {
      project_id:      true,
      budget_usd:      true,
      cost_actual_usd: true,
    },
  })

  const buckets = new Map<string, { total: number; overshoot: number }>()

  for (const run of runs) {
    const b = buckets.get(run.project_id) ?? { total: 0, overshoot: 0 }
    b.total++
    // Decimal → number comparison
    if (Number(run.cost_actual_usd) > Number(run.budget_usd)) b.overshoot++
    buckets.set(run.project_id, b)
  }

  return Array.from(buckets.entries()).map(([project_id, b]) => ({
    project_id,
    runs_with_budget: b.total,
    runs_overshoot:   b.overshoot,
    overshoot_rate:   b.total > 0 ? b.overshoot / b.total : 0,
  }))
}

// ─── Human gate frequency + abandonment ──────────────────────────────────────

async function computeGateStats(
  from: Date,
  to: Date,
): Promise<{ frequency: GateFrequencyStat[]; abandoned: number }> {
  const [gates, totalCompleted] = await Promise.all([
    db.humanGate.findMany({
      where: { run: { created_at: { gte: from, lte: to } } },
      select: { reason: true, status: true, opened_at: true },
    }),
    db.run.count({
      where: {
        created_at: { gte: from, lte: to },
        status: 'COMPLETED',
      },
    }),
  ])

  // Abandoned = open gates older than 48 h
  const cutoff = new Date(Date.now() - 48 * 3600_000)
  let abandoned = 0
  const reasonCounts = new Map<string, number>()

  for (const g of gates) {
    reasonCounts.set(g.reason, (reasonCounts.get(g.reason) ?? 0) + 1)
    if (g.status === 'OPEN' && g.opened_at < cutoff) abandoned++
  }

  const frequency: GateFrequencyStat[] = Array.from(reasonCounts.entries()).map(
    ([reason, count]) => ({
      reason,
      count,
      rate: totalCompleted > 0 ? count / totalCompleted : 0,
    }),
  )

  return { frequency, abandoned }
}
