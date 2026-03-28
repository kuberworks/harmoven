// lib/llm/confidentiality.ts
// Local Confidentiality Classifier — Section 18 AGENTS-01, V1_SCOPE required.
//
// Rules:
//   - Runs entirely locally — NO LLM call, NO cloud call.
//   - Regex-based pattern matching (IBAN, SIRET, SSN, passport, VAT, UIDAI…)
//   - Keyword dictionary for privilege/classification markers (multilingual)
//   - Signals are typed + counted; raw values are never returned (privacy).
//   - Result is a 4-level score: LOW | MEDIUM | HIGH | CRITICAL
//
// Score thresholds:
//   CRITICAL — legal privilege marker OR classified header detected
//   HIGH     — clear PII (SSN, passport, health data) OR 3+ signals
//   MEDIUM   — financial identifiers OR 1–2 signals
//   LOW      — no signals detected
//
// Usage:
//   import { classifyConfidentiality } from '@/lib/llm/confidentiality'
//   const result = classifyConfidentiality(text)
//   → { score: 'HIGH', signals: [...], llm_tier_required: 2, classifier_version: '1.0' }

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfidentialityScore = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface ConfidentialitySignal {
  type: string
  count: number
}

export interface ConfidentialityResult {
  score: ConfidentialityScore
  signals: ConfidentialitySignal[]
  /** Minimum LLM trust tier required. 1=local-only 2=API commercial 3=any */
  llm_tier_required: 1 | 2 | 3
  determined_at: string
  classifier_version: '1.0'
}

// ─── Pattern definitions ──────────────────────────────────────────────────────

interface PatternGroup {
  type: string
  /** Score contribution of this signal type. */
  severity: 'critical' | 'high' | 'medium'
  pattern: RegExp
}

const PATTERNS: PatternGroup[] = [
  // ── Legal privilege / classified markers (CRITICAL) ──────────────────────
  {
    type: 'legal_privilege_marker',
    severity: 'critical',
    pattern:
      /attorney.client\s+privilege|privileged\s*&?\s*confidential|work\s+product\s+doctrine|legally\s+privileged|ohne\s+präjudiz|acte\s+d['']avocat/i,
  },
  {
    type: 'classified_document_header',
    severity: 'critical',
    pattern:
      /\b(top\s+secret|ts\/sci|confidential\s+national|classified|secret\s+d['']état|confidentiel\s+défense|verschlusssache)\b/i,
  },
  {
    type: 'm_and_a_marker',
    severity: 'critical',
    pattern: /\b(project\s+\w+\s+nda|due\s+diligence|material\s+non.public\s+information|mnpi)\b/i,
  },

  // ── Strong PII — individuals (HIGH) ────────────────────────────────────────
  {
    // US Social Security Number: 3-2-4 digits (dashes or spaces)
    type: 'ssn',
    severity: 'high',
    pattern: /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/,
  },
  {
    // French NIR (numéro de sécurité sociale): 13 digits + 2 check digits
    type: 'nir_france',
    severity: 'high',
    pattern: /\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/,
  },
  {
    // Passport-style MRZ line or explicit passport reference
    type: 'passport_number',
    severity: 'high',
    pattern: /passport\s*(?:no|number|#|:)?\s*[A-Z]{1,3}\d{6,9}/i,
  },
  {
    // Generic ID number reference (multilingual)
    type: 'national_id_reference',
    severity: 'high',
    pattern:
      /\b(carte\s+nationale\s+d['']identit[eé]|national\s+id\s+(?:no|number)|personalausweis|DNI|NIF|CPF|CURP|PESEL|BSN)\s*:?\s*[\dA-Z-]{6,}/i,
  },
  {
    // UIDAI Aadhaar: 12 digits in xxxx-xxxx-xxxx or plain
    type: 'aadhaar',
    severity: 'high',
    pattern: /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/,
  },
  {
    // Health data keywords
    type: 'health_data_keyword',
    severity: 'high',
    pattern:
      /\b(diagnosis|diagnostic|prescription|dossier\s+médical|medical\s+record|patient\s+id|icd-1[01]|dsm-[iv5]+|hiv|cancer|antidépresseur|antidepressant)\b/i,
  },

  // ── Financial identifiers (MEDIUM → HIGH depending on count) ────────────────
  {
    // IBAN: 15–34 alphanumeric chars, starts with 2 letters
    type: 'iban',
    severity: 'medium',
    pattern: /\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/,
  },
  {
    // French SIRET: 14 digits (optionally spaced 3-3-3-5 or 9-5)
    type: 'siret',
    severity: 'medium',
    pattern: /\b\d{3}\s?\d{3}\s?\d{3}\s?\d{5}\b/,
  },
  {
    // French SIREN: 9 digits
    type: 'siren',
    severity: 'medium',
    pattern: /\b(?:SIREN|numéro\s+d['']entreprise)\s*:?\s*\d{3}\s?\d{3}\s?\d{3}\b/i,
  },
  {
    // EU VAT number: 2-letter country code + 8–12 alphanumeric
    type: 'vat_number',
    severity: 'medium',
    pattern: /\b(VAT|TVA|MwSt\.?|BTW|IVA|UID)\s*(?:no\.?|nr\.?|number)?\s*[A-Z]{2}[\dA-Z]{8,12}\b/i,
  },
  {
    // Credit / debit card: 4 groups of 4 digits (Luhn-shaped, not validated)
    type: 'payment_card',
    severity: 'medium',
    pattern: /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b|\b5[12345]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  },

  // ── Confidentiality keyword markers (MEDIUM) ─────────────────────────────
  {
    type: 'keyword_marker',
    severity: 'medium',
    pattern:
      /\b(confidentiel|confidential|strictly\s+confidential|do\s+not\s+distribute|ne\s+pas\s+diffuser|streng\s+vertraulich|riservatissimo|propriétaire|proprietary|internal\s+use\s+only|internal\s+only)\b/i,
  },
]

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify the confidentiality level of a text string.
 *
 * Runs entirely locally — no LLM call, no network call.
 * Signal values are intentionally NOT returned (only type + count).
 */
export function classifyConfidentiality(text: string): ConfidentialityResult {
  const signals: ConfidentialitySignal[] = []
  let hasCritical = false
  let highCount = 0
  let mediumCount = 0

  for (const { type, severity, pattern } of PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g')))
    const count = matches?.length ?? 0
    if (count === 0) continue

    signals.push({ type, count })

    if (severity === 'critical') hasCritical = true
    else if (severity === 'high') highCount += 1
    else mediumCount += count  // count instances for medium signals
  }

  let score: ConfidentialityScore
  let llm_tier_required: 1 | 2 | 3

  if (hasCritical) {
    score = 'CRITICAL'
    llm_tier_required = 1
  } else if (highCount >= 1 || signals.length >= 3) {
    score = 'HIGH'
    llm_tier_required = 2
  } else if (mediumCount >= 1 || signals.length >= 1) {
    score = 'MEDIUM'
    llm_tier_required = 2
  } else {
    score = 'LOW'
    llm_tier_required = 3
  }

  return {
    score,
    signals,
    llm_tier_required,
    determined_at: new Date().toISOString(),
    classifier_version: '1.0',
  }
}
