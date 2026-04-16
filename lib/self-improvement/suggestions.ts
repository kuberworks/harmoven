// lib/self-improvement/suggestions.ts
// Pure rule engine: InstanceMetrics → ImprovementSuggestionInput[].
// No DB access. No side effects. Easily testable.

import type {
  SelfImprovementConfig,
  InstanceMetrics,
  ImprovementSuggestionInput,
  SuggestionEvidence,
} from './types'

const SUGGESTION_TTL_DAYS = 14

function expiresAt(): Date {
  return new Date(Date.now() + SUGGESTION_TTL_DAYS * 86_400_000)
}

function evidence(
  window_days:  number,
  sample_count: number,
  metric_value: number,
  metric_label: string,
  threshold:    number,
  extras?:      Record<string, unknown>,
): SuggestionEvidence {
  return { window_days, sample_count, metric_value, metric_label, threshold, extras }
}

export function generateSuggestions(
  metrics: InstanceMetrics,
  cfg: SelfImprovementConfig,
): ImprovementSuggestionInput[] {
  const results: ImprovementSuggestionInput[] = []
  const w = cfg.lookback_days

  // ── LLM_PROFILE_ERROR_RATE ──────────────────────────────────────────────────
  for (const stat of metrics.profileNodeStats) {
    if (stat.total < cfg.min_sample_size) continue
    if (stat.error_rate <= cfg.threshold_error_rate) continue
    const pct = Math.round(stat.error_rate * 100)
    results.push({
      type:        'LLM_PROFILE_ERROR_RATE',
      severity:    stat.error_rate >= 0.5 ? 'critical' : 'warning',
      title:       `admin.self_improvement.type.LLM_PROFILE_ERROR_RATE`,
      body:        `Profile **${stat.llm_profile_id}** has a ${pct}% error rate on ${stat.agent_type} nodes over the last ${w} days. Consider disabling this profile or checking provider status.`,
      evidence:    evidence(w, stat.total, stat.error_rate, `${pct}% error rate`, cfg.threshold_error_rate, {
        profile_id:    stat.llm_profile_id,
        agent_type:    stat.agent_type,
        errors:        stat.errors,
        total:         stat.total,
      }),
      target_id:   stat.llm_profile_id,
      target_type: 'llm_profile',
      cycle_key:   `LLM_PROFILE_ERROR_RATE:${stat.llm_profile_id}:${stat.agent_type}:${w}d`,
      expires_at:  expiresAt(),
    })
  }

  // ── LLM_PROFILE_LOW_SCORE ───────────────────────────────────────────────────
  for (const stat of metrics.profileEvalStats) {
    if (stat.total_evals < cfg.min_sample_size) continue
    if (stat.avg_score >= cfg.threshold_low_score) continue
    results.push({
      type:        'LLM_PROFILE_LOW_SCORE',
      severity:    stat.avg_score < 2.0 ? 'critical' : 'warning',
      title:       `admin.self_improvement.type.LLM_PROFILE_LOW_SCORE`,
      body:        `Profile **${stat.llm_used}** averages a quality score of ${stat.avg_score.toFixed(1)}/5 over the last ${w} days (${stat.total_evals} evals).`,
      evidence:    evidence(w, stat.total_evals, stat.avg_score, `${stat.avg_score.toFixed(1)}/5 avg score`, cfg.threshold_low_score, {
        profile_id:     stat.llm_used,
        rejection_rate: stat.rejection_rate,
      }),
      target_id:   stat.llm_used,
      target_type: 'llm_profile',
      cycle_key:   `LLM_PROFILE_LOW_SCORE:${stat.llm_used}:${w}d`,
      expires_at:  expiresAt(),
    })
  }

  // ── RETRY_STORM ─────────────────────────────────────────────────────────────
  const retryByAgent = new Map<string, { sum: number; count: number }>()
  for (const stat of metrics.profileNodeStats) {
    const b = retryByAgent.get(stat.agent_type) ?? { sum: 0, count: 0 }
    b.sum   += stat.retries_sum
    b.count += stat.total
    retryByAgent.set(stat.agent_type, b)
  }
  for (const [agent_type, b] of retryByAgent) {
    if (b.count < cfg.min_sample_size) continue
    const avg = b.sum / b.count
    if (avg <= cfg.threshold_retry_avg) continue
    results.push({
      type:        'RETRY_STORM',
      severity:    avg >= 3 ? 'critical' : 'warning',
      title:       `admin.self_improvement.type.RETRY_STORM`,
      body:        `${agent_type} nodes average ${avg.toFixed(1)} retries per execution over the last ${w} days. This may indicate provider instability or prompt issues.`,
      evidence:    evidence(w, b.count, avg, `${avg.toFixed(1)} avg retries`, cfg.threshold_retry_avg, { agent_type }),
      cycle_key:   `RETRY_STORM:${agent_type}:${w}d`,
      expires_at:  expiresAt(),
    })
  }

  // ── REVIEWER_REJECTION_RATE ─────────────────────────────────────────────────
  const totalEvals     = metrics.profileEvalStats.reduce((s, e) => s + e.total_evals, 0)
  const totalRejections = metrics.profileEvalStats.reduce(
    (s, e) => s + Math.round(e.rejection_rate * e.total_evals), 0,
  )
  if (totalEvals >= cfg.min_sample_size) {
    const rate = totalRejections / totalEvals
    if (rate > cfg.threshold_rejection_rate) {
      const pct = Math.round(rate * 100)
      results.push({
        type:      'REVIEWER_REJECTION_RATE',
        severity:  rate >= 0.6 ? 'critical' : 'warning',
        title:     `admin.self_improvement.type.REVIEWER_REJECTION_RATE`,
        body:      `${pct}% of reviewer evaluations requested revisions over the last ${w} days. Consider reviewing domain profile prompts or LLM quality settings.`,
        evidence:  evidence(w, totalEvals, rate, `${pct}% rejection rate`, cfg.threshold_rejection_rate, {
          total_evals:  totalEvals,
          rejections:   totalRejections,
        }),
        cycle_key:  `REVIEWER_REJECTION_RATE:global:${w}d`,
        expires_at: expiresAt(),
      })
    }
  }

  // ── BUDGET_OVERSHOOT ────────────────────────────────────────────────────────
  for (const stat of metrics.projectBudgetStats) {
    if (stat.runs_with_budget < cfg.min_sample_size) continue
    if (stat.overshoot_rate <= cfg.threshold_budget_overshoot) continue
    const pct = Math.round(stat.overshoot_rate * 100)
    results.push({
      type:        'BUDGET_OVERSHOOT',
      severity:    stat.overshoot_rate >= 0.75 ? 'critical' : 'warning',
      title:       `admin.self_improvement.type.BUDGET_OVERSHOOT`,
      body:        `${pct}% of budgeted runs in project ${stat.project_id.slice(0, 8)} exceeded their budget over the last ${w} days.`,
      evidence:    evidence(w, stat.runs_with_budget, stat.overshoot_rate, `${pct}% overshoot rate`, cfg.threshold_budget_overshoot, {
        project_id:       stat.project_id,
        runs_with_budget: stat.runs_with_budget,
        runs_overshoot:   stat.runs_overshoot,
      }),
      target_id:   stat.project_id,
      target_type: 'project',
      cycle_key:   `BUDGET_OVERSHOOT:${stat.project_id}:${w}d`,
      expires_at:  expiresAt(),
    })
  }

  // ── GATE_FREQUENCY ──────────────────────────────────────────────────────────
  for (const stat of metrics.gateFrequencyStats) {
    if (stat.count < cfg.min_sample_size) continue
    if (stat.rate <= cfg.threshold_gate_frequency) continue
    const pct = Math.round(stat.rate * 100)
    results.push({
      type:      'GATE_FREQUENCY',
      severity:  'warning',
      title:     `admin.self_improvement.type.GATE_FREQUENCY`,
      body:      `Human gates with reason **${stat.reason}** are triggered in ${pct}% of completed runs over the last ${w} days. Review the gate configuration for this trigger.`,
      evidence:  evidence(w, stat.count, stat.rate, `${pct}% of runs trigger this gate`, cfg.threshold_gate_frequency, {
        reason: stat.reason,
        count:  stat.count,
      }),
      target_type: 'gate_config',
      cycle_key:   `GATE_FREQUENCY:${stat.reason}:${w}d`,
      expires_at:  expiresAt(),
    })
  }

  // ── GATE_ABANDONMENT ────────────────────────────────────────────────────────
  if (metrics.gateAbandonedCount > 0) {
    results.push({
      type:      'GATE_ABANDONMENT',
      severity:  metrics.gateAbandonedCount >= 5 ? 'critical' : 'warning',
      title:     `admin.self_improvement.type.GATE_ABANDONMENT`,
      body:      `${metrics.gateAbandonedCount} human gate(s) have been open for more than 48 hours. These runs are stuck. Check that gate timeout configuration and notification settings are correct.`,
      evidence:  evidence(w, metrics.gateAbandonedCount, metrics.gateAbandonedCount, `${metrics.gateAbandonedCount} abandoned gate(s)`, 1, {
        count: metrics.gateAbandonedCount,
      }),
      cycle_key:  `GATE_ABANDONMENT:global:${w}d`,
      expires_at: expiresAt(),
    })
  }

  return results
}
