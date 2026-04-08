// lib/llm/selector.ts
// Multi-criteria LLM selector — TECHNICAL.md Section 6.
//
// Two public entry-points:
//
//   selectByTier(tier, profiles)
//     → simple lookup used by agents: 'fast' | 'balanced' | 'powerful'
//     → returns the first enabled profile in that tier
//
//   selectLlm(input)
//     → full multi-criteria scorer — used by the DAG executor for production routing
//     → applies hard constraints (confidentiality, jurisdiction, context window)
//       then scores remaining candidates and returns the best
//
//   selectImageModel(ctx?)
//     → find enabled profiles with modality='image', apply jurisdiction/confidentiality,
//       return the first match or throw if none configured

import type { LlmProfileConfig } from './profiles'
import { db } from '@/lib/db/client'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ConfidentialityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface DagNodeHint {
  /** task_type string (e.g. 'intent_classification', 'strategic_planning'). */
  task_type?: string
  /** Node complexity — affects tier affinity score. */
  complexity?: 'low' | 'medium' | 'high'
  /** Estimated tokens for this node (used for context window check). */
  estimated_tokens?: number
}

export interface SelectLlmInput {
  node:               DagNodeHint
  confidentiality?:   ConfidentialityLevel
  jurisdictionTags?:  string[]     // ['no_cn_jurisdiction', 'eu_only', 'local_only']
  preferredLlmId?:    string       // run.run_config.preferred_llm
  budgetRemaining?:   number       // run.budget_usd − run.cost_actual_usd
  candidates:         LlmProfileConfig[]
}

// ─── Hard constraints ──────────────────────────────────────────────────────────

/**
 * Confidentiality gate (TECHNICAL.md §6, Confidentiality × jurisdiction gate):
 *   CRITICAL → local model only
 *   HIGH     → trust_tier ≤ 2
 *   MEDIUM   → trust_tier 1-3 (all cloud allowed)
 *   LOW      → all
 */
export function meetsConfidentialityConstraint(
  profile: LlmProfileConfig,
  level:   ConfidentialityLevel,
): boolean {
  if (level === 'CRITICAL') return profile.jurisdiction === 'local'
  if (level === 'HIGH')     return profile.trust_tier <= 2
  return true   // MEDIUM and LOW allow all trust tiers
}

/**
 * Jurisdiction gate:
 *   'no_cn_jurisdiction' → exclude CN providers
 *   'eu_only'            → eu or local only
 *   'local_only'         → local only
 */
export function meetsJurisdictionConstraint(
  profile: LlmProfileConfig,
  tags:    string[],
): boolean {
  if (tags.includes('no_cn_jurisdiction') && profile.jurisdiction === 'cn')
    return false
  if (tags.includes('eu_only') && !(['eu', 'local'] as string[]).includes(profile.jurisdiction))
    return false
  if (tags.includes('local_only') && profile.jurisdiction !== 'local')
    return false
  return true
}

/**
 * Context window gate: node must fit in the model's context.
 * If estimated_tokens is undefined, the constraint is skipped.
 */
export function meetsContextWindowConstraint(
  profile:          LlmProfileConfig,
  estimatedTokens?: number,
): boolean {
  if (estimatedTokens === undefined) return true
  return profile.context_window >= estimatedTokens
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Cost weights by task type (TECHNICAL.md §6).
 * Higher value = cost is more important. Scale 5–60.
 */
const COST_WEIGHTS: Record<string, number> = {
  // Cost dominates — cheap models sufficient
  intent_classification:    60,
  context_distillation:     60,
  high_volume_coding:       50,
  layer_agent_execution:    50,
  simple_coding_tasks:      55,

  // Balanced
  document_analysis:        30,
  report_writing:           30,
  research_synthesis:       28,
  marketing_content:        30,
  hr_recruiting:            28,

  // Quality-critical — cost near-irrelevant
  strategic_planning:       10,
  legal_reasoning:           5,
  ambiguity_resolution:      8,
  complex_analysis:         15,
  long_context_analysis:    20,
}

function estimateCostUsd(estimatedTokens: number | undefined, profile: LlmProfileConfig): number {
  const tokens = estimatedTokens ?? 4_000   // default estimate
  const inputCost  = (tokens * 0.7) / 1_000_000 * profile.cost_per_1m_input_tokens
  const outputCost = (tokens * 0.3) / 1_000_000 * profile.cost_per_1m_output_tokens
  return inputCost + outputCost
}

/**
 * Normalise cost into a [0, 30] score where cheaper = higher score.
 * Uses relative position in the pool.
 */
function normaliseCostScore(cost: number, pool: LlmProfileConfig[], estimatedTokens?: number): number {
  const costs = pool.map(p => estimateCostUsd(estimatedTokens, p))
  const maxCost = Math.max(...costs)
  const minCost = Math.min(...costs)
  if (maxCost === minCost) return 15   // all same cost
  return Math.round(30 * (1 - (cost - minCost) / (maxCost - minCost)))
}

export function scoreProfile(
  profile: LlmProfileConfig,
  node:    DagNodeHint,
  pool:    LlmProfileConfig[],
  preferredLlmId?: string,
  budgetRemaining?: number,
): number {
  let score = 0

  // 1. Task type affinity (0–40 pts)
  if (node.task_type && profile.task_type_affinity.includes(node.task_type)) {
    score += 40
  } else if (node.complexity === 'high' && profile.tier === 'powerful') {
    score += 20
  }

  // 2. Cost efficiency — weight varies by task type (0–60 pts)
  const costWeight: number = (node.task_type ? (COST_WEIGHTS[node.task_type] ?? 25) : 25)
  const estimatedCost  = estimateCostUsd(node.estimated_tokens, profile)
  const costScore      = normaliseCostScore(estimatedCost, pool, node.estimated_tokens)
  score += Math.round(costScore * costWeight / 30)

  // 3. Project preference (0–20 pts)
  if (preferredLlmId && profile.id === preferredLlmId) score += 20

  // 4. Budget headroom (0–10 pts)
  if (budgetRemaining !== undefined && estimatedCost < budgetRemaining * 0.3) score += 10

  return score
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Simple tier-based selection — used by agents.
 * Returns the first active profile matching the requested tier.
 * Tier precedence: exact match, then more powerful tiers as fallback.
 */
export function selectByTier(
  tier:     string,
  profiles: LlmProfileConfig[],
): LlmProfileConfig | null {
  // Exact tier match first
  const exact = profiles.find(p => p.tier === tier)
  if (exact) return exact

  // Fallback: if no 'powerful' found, use 'balanced'; if no 'balanced', 'fast'
  if (tier === 'powerful') return profiles.find(p => p.tier === 'balanced') ?? profiles.find(p => p.tier === 'fast') ?? null
  if (tier === 'balanced') return profiles.find(p => p.tier === 'fast') ?? null
  return null
}

/**
 * Full multi-criteria selection — used by the DAG executor for production routing.
 * Applies hard constraints then scores the eligible candidates.
 * Returns null if no eligible model is available (hard block → escalate to human).
 */
export function selectLlm(input: SelectLlmInput): LlmProfileConfig | null {
  const { node, confidentiality = 'MEDIUM', jurisdictionTags = [], preferredLlmId, budgetRemaining, candidates } = input

  // Filter: hard constraints
  const eligible = candidates.filter(p =>
    meetsConfidentialityConstraint(p, confidentiality) &&
    meetsJurisdictionConstraint(p, jurisdictionTags)   &&
    meetsContextWindowConstraint(p, node.estimated_tokens),
  )
  if (eligible.length === 0) return null

  // Score remaining candidates
  const scored = eligible.map(p => ({
    profile: p,
    score:   scoreProfile(p, node, eligible, preferredLlmId, budgetRemaining),
  }))
  scored.sort((a, b) => b.score - a.score)

  return scored[0]?.profile ?? null
}

// ─── Image model selector ──────────────────────────────────────────────────

/**
 * Find an enabled LlmProfile with modality='image'.
 * Applies the same jurisdiction / confidentiality hard-constraints as selectLlm().
 * Returns the first match by cost (cheapest first).
 * Throws 'No image generation model configured' when none passes filtering.
 */
export async function selectImageModel(
  ctx?: {
    confidentiality?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    jurisdictionTags?: string[]
  },
): Promise<LlmProfileConfig & { modality: string }> {
  // Fetch all enabled modality=image profiles from DB
  const rows = await db.llmProfile.findMany({
    where: { enabled: true, modality: 'image' },
  })

  if (rows.length === 0) {
    throw new Error('No image generation model configured')
  }

  // Map Prisma rows to LlmProfileConfig shape
  const profiles: Array<LlmProfileConfig & { modality: string }> = rows.map(r => ({
    id:                       r.id,
    provider:                 r.provider,
    model_string:             r.model_string,
    tier:                     r.tier as 'fast' | 'balanced' | 'powerful',
    context_window:           r.context_window,
    cost_per_1m_input_tokens:  Number(r.cost_per_1m_input_tokens),
    cost_per_1m_output_tokens: Number(r.cost_per_1m_output_tokens),
    jurisdiction:             r.jurisdiction as 'us' | 'eu' | 'cn' | 'local',
    trust_tier:               r.trust_tier as 1 | 2 | 3,
    task_type_affinity:       r.task_type_affinity,
    config:                   r.config as Record<string, unknown>,
    modality:                 r.modality,
  }))

  // Apply hard constraints
  const confidentiality = ctx?.confidentiality ?? 'LOW'
  const jurisdictionTags = ctx?.jurisdictionTags ?? []

  const eligible = profiles.filter(p =>
    meetsConfidentialityConstraint(p, confidentiality) &&
    meetsJurisdictionConstraint(p, jurisdictionTags),
  )

  if (eligible.length === 0) {
    throw new Error('No image generation model configured')
  }

  // Cheapest first as tie-breaker
  eligible.sort((a, b) => a.cost_per_1m_input_tokens - b.cost_per_1m_input_tokens)
  return eligible[0]!
}
