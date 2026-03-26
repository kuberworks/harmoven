// lib/agents/reviewer/critical-reviewer.types.ts
// Types for the CriticalReviewer agent — Amendment 75 / Section 27

// ─── Severity scale ───────────────────────────────────────────────────────────
// 0=off  1=lenient  2=standard  3=strict  4=thorough  5=paranoid

export type CriticalSeverity = 0 | 1 | 2 | 3 | 4 | 5

// ─── Per-domain defaults ──────────────────────────────────────────────────────

export const CRITICAL_SEVERITY_DEFAULTS: Record<string, CriticalSeverity> = {
  app_scaffolding:    2,
  legal_compliance:   4,
  finance_modeling:   4,
  data_reporting:     2,
  document_drafting:  1,
  marketing_content:  1,
  hr_recruiting:      2,
  ecommerce_ops:      2,
  research_synthesis: 3,
  training_content:   1,
  customer_support:   2,
  medical_support:    5,
}

// Preset bake-ins (Am.59): non_tech_guided→1, dev_senior→3, regulated→5
export const PRESET_SEVERITY: Record<string, CriticalSeverity> = {
  non_tech_guided: 1,
  dev_senior:      3,
  regulated:       5,
}

// ─── Finding types ────────────────────────────────────────────────────────────

export type FindingSeverity = 'blocking' | 'important' | 'watch'

export type FindingDomain =
  | 'security'
  | 'architecture'
  | 'scalability'
  | 'assumptions'
  | 'compliance'
  | 'hardware'
  | 'maintenance'
  | 'dependencies'
  | 'safety'

export interface CriticalFinding {
  id:          string
  severity:    FindingSeverity
  title:       string        // max 10 words, direct
  observation: string        // factual, 1-2 sentences
  impact:      string        // concrete consequence, 1 sentence
  suggestion:  string | null // actionable fix, or null
  domain:      string        // FindingDomain | string (extensible)
}

// ─── Agent output ─────────────────────────────────────────────────────────────

export interface CriticalReviewerOutput {
  verdict:    'no_issues' | 'issues_found'
  severity:   CriticalSeverity
  findings:   CriticalFinding[] // MAX 3 — enforced in system prompt
  suppressed: number            // count below threshold, not shown
  rationale:  string
  meta: {
    llm_used:        string
    tokens_input:    number
    tokens_output:   number
    duration_seconds: number
    cost_usd:        number
  }
}

// ─── Severity resolution ──────────────────────────────────────────────────────

export interface SeverityResolutionInput {
  /** run_config.critical_reviewer_severity — highest priority */
  runConfigSeverity?: number | null
  /** project.config.critical_reviewer.severity */
  projectSeverity?: number | null
  /** run_config.preset — e.g. 'dev_senior' */
  preset?: string | null
  /** run.domain_profile — e.g. 'app_scaffolding' */
  domainProfile?: string | null
}

export function resolveCriticalSeverity(input: SeverityResolutionInput): CriticalSeverity {
  const candidate =
    input.runConfigSeverity ??
    input.projectSeverity ??
    (input.preset ? PRESET_SEVERITY[input.preset] : undefined) ??
    (input.domainProfile ? CRITICAL_SEVERITY_DEFAULTS[input.domainProfile] : undefined) ??
    2

  // Clamp to valid range [0,5]
  const clamped = Math.max(0, Math.min(5, Math.round(candidate))) as CriticalSeverity
  return clamped
}
