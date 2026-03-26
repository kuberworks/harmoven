// lib/agents/eval/eval-rubrics.ts
// Amendment 89 — Domain rubrics for EvalAgent sprint contract negotiation.
//
// Each rubric defines the EvalCriteria used when negotiating a SprintContract
// for a given domain profile.  Profiles not listed here fall back to GENERIC_RUBRIC.

import type { EvalCriterion } from './eval.types'

// ─── Generic fallback rubric ─────────────────────────────────────────────────

export const GENERIC_RUBRIC: EvalCriterion[] = [
  {
    id: 'objective_met',
    name: 'Objective met',
    weight: 0.4,
    hard_fail: true,
  },
  {
    id: 'accuracy',
    name: 'Accuracy & correctness',
    weight: 0.3,
    hard_fail: false,
  },
  {
    id: 'clarity',
    name: 'Clarity & completeness',
    weight: 0.2,
    hard_fail: false,
  },
  {
    id: 'format',
    name: 'Format & structure',
    weight: 0.1,
    hard_fail: false,
  },
]

// ─── Marketing content ────────────────────────────────────────────────────────

export const MARKETING_CONTENT_RUBRIC: EvalCriterion[] = [
  {
    id: 'cta_present',
    name: 'Call to action present',
    weight: 0.25,
    hard_fail: true,   // no CTA = automatic retry
  },
  {
    id: 'tone',
    name: 'Tone matching brand voice',
    weight: 0.20,
    hard_fail: false,
  },
  {
    id: 'clarity',
    name: 'Clarity & readability',
    weight: 0.20,
    hard_fail: false,
  },
  {
    id: 'length',
    name: 'Length appropriate for channel',
    weight: 0.15,
    hard_fail: false,
  },
  {
    id: 'structure',
    name: 'Structure (headline, body, CTA)',
    weight: 0.10,
    hard_fail: false,
  },
  {
    id: 'originality',
    name: 'No invented brand claims',
    weight: 0.10,
    hard_fail: true,   // hallucinated claims = retry
  },
]

// ─── App scaffolding ──────────────────────────────────────────────────────────

export const APP_SCAFFOLDING_RUBRIC: EvalCriterion[] = [
  {
    id: 'compiles',
    name: 'Project compiles / type-checks',
    weight: 0.30,
    hard_fail: true,   // won't work at all
  },
  {
    id: 'tests_pass',
    name: 'Generated tests pass',
    weight: 0.25,
    hard_fail: true,
  },
  {
    id: 'smoke',
    name: 'Smoke test smoke strategy succeeded',
    weight: 0.25,
    hard_fail: true,
  },
  {
    id: 'docs',
    name: 'README / DEPLOYMENT.md present and complete',
    weight: 0.10,
    hard_fail: false,
  },
  {
    id: 'security_basics',
    name: 'No obvious security issues (secrets, SQL injection)',
    weight: 0.10,
    hard_fail: false,
  },
]

// ─── Legal compliance ─────────────────────────────────────────────────────────

export const LEGAL_COMPLIANCE_RUBRIC: EvalCriterion[] = [
  {
    id: 'completeness',
    name: 'All required clauses present',
    weight: 0.35,
    hard_fail: true,
  },
  {
    id: 'citations',
    name: 'Legal references are cited',
    weight: 0.25,
    hard_fail: true,
  },
  {
    id: 'jurisdiction',
    name: 'Correct jurisdiction applied',
    weight: 0.20,
    hard_fail: false,
  },
  {
    id: 'disclaimer',
    name: '"Consult a lawyer" disclaimer present',
    weight: 0.15,
    hard_fail: true,
  },
  {
    id: 'plain_language',
    name: 'Plain language where required',
    weight: 0.05,
    hard_fail: false,
  },
]

// ─── Data reporting ───────────────────────────────────────────────────────────

export const DATA_REPORTING_RUBRIC: EvalCriterion[] = [
  {
    id: 'sourced_stats',
    name: 'Every statistic traceable to input data',
    weight: 0.35,
    hard_fail: true,
  },
  {
    id: 'accuracy',
    name: 'Calculations correct',
    weight: 0.30,
    hard_fail: true,
  },
  {
    id: 'visualisation',
    name: 'Charts / tables clearly labelled',
    weight: 0.20,
    hard_fail: false,
  },
  {
    id: 'completeness',
    name: 'All requested KPIs addressed',
    weight: 0.15,
    hard_fail: false,
  },
]

// ─── Finance modeling ─────────────────────────────────────────────────────────

export const FINANCE_MODELING_RUBRIC: EvalCriterion[] = [
  {
    id: 'traceable_figures',
    name: 'All figures traceable to input data',
    weight: 0.35,
    hard_fail: true,
  },
  {
    id: 'formula_correctness',
    name: 'Formulae mathematically correct',
    weight: 0.30,
    hard_fail: true,
  },
  {
    id: 'assumptions_documented',
    name: 'Assumptions explicitly documented',
    weight: 0.20,
    hard_fail: false,
  },
  {
    id: 'range_analysis',
    name: 'Sensitivity / scenario ranges provided',
    weight: 0.15,
    hard_fail: false,
  },
]

// ─── HR / Recruiting ──────────────────────────────────────────────────────────

export const HR_RECRUITING_RUBRIC: EvalCriterion[] = [
  {
    id: 'requirements_covered',
    name: 'All job requirements addressed',
    weight: 0.30,
    hard_fail: true,
  },
  {
    id: 'bias_free',
    name: 'No discriminatory language',
    weight: 0.30,
    hard_fail: true,
  },
  {
    id: 'clarity',
    name: 'Clear and readable',
    weight: 0.25,
    hard_fail: false,
  },
  {
    id: 'format',
    name: 'Correct format for channel (job board, internal, etc.)',
    weight: 0.15,
    hard_fail: false,
  },
]

// ─── Research synthesis ───────────────────────────────────────────────────────

export const RESEARCH_SYNTHESIS_RUBRIC: EvalCriterion[] = [
  {
    id: 'coverage',
    name: 'All requested topics covered',
    weight: 0.30,
    hard_fail: true,
  },
  {
    id: 'sourced_claims',
    name: 'Claims supported by cited or input sources',
    weight: 0.30,
    hard_fail: true,
  },
  {
    id: 'objectivity',
    name: 'Balanced, unbiased perspective',
    weight: 0.25,
    hard_fail: false,
  },
  {
    id: 'synthesis',
    name: 'Insights synthesised (not just summarised)',
    weight: 0.15,
    hard_fail: false,
  },
]

// ─── Registry ─────────────────────────────────────────────────────────────────

const RUBRIC_REGISTRY: Record<string, EvalCriterion[]> = {
  marketing_content:  MARKETING_CONTENT_RUBRIC,
  app_scaffolding:    APP_SCAFFOLDING_RUBRIC,
  legal_compliance:   LEGAL_COMPLIANCE_RUBRIC,
  data_reporting:     DATA_REPORTING_RUBRIC,
  finance_modeling:   FINANCE_MODELING_RUBRIC,
  hr_recruiting:      HR_RECRUITING_RUBRIC,
  research_synthesis: RESEARCH_SYNTHESIS_RUBRIC,
}

/**
 * Returns the domain rubric for a given profile.
 * Falls back to GENERIC_RUBRIC for unknown / unlisted profiles.
 */
export function getRubricForProfile(profileId: string): EvalCriterion[] {
  return RUBRIC_REGISTRY[profileId] ?? GENERIC_RUBRIC
}
