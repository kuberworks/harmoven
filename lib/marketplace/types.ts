// lib/marketplace/types.ts
// Shared types for marketplace pack installation and management.
// Spec: TECHNICAL.md §39.5, Amendment 66/67/68.

export interface PackManifest {
  /** Unique marketplace identifier, e.g. "invoice_followup_fr" */
  pack_id:         string
  /** Human-readable name */
  name:            string
  /** Semantic version, e.g. "1.2.0" */
  version:         string
  /** Pack author / contributor */
  author:          string
  /** Short description (max 200 chars) */
  description:     string
  /** Pack category tags */
  tags:            string[]
  /** Pack definition content (YAML/JSON string) */
  content:         string
  /** SHA-256 hex of content — verified at install */
  content_sha256:  string
  /** GPG detached signature (ASCII-armored) — verified in T3.8 */
  signature?:      string
  /** URL to pack manifest on registry */
  registry_url?:   string
  /** Bayesian rating from registry (pre-computed) */
  bayesian_rating?: number
  /** Usage count from registry */
  install_count?:  number
}

export interface PackScanResult {
  passed:         boolean
  hasInjection:   boolean
  hasExternalUrl: boolean
  reason?:        string
}

/** Computed bayesian score per Amendment 68.1 */
export function computeBayesianScore(
  rawAverage:     number,
  ratingCount:    number,
  globalAverage = 3.5,
  confidence     = 10,
): number {
  // score = (N × R + C × m) / (N + C)
  return (ratingCount * rawAverage + confidence * globalAverage) / (ratingCount + confidence)
}
