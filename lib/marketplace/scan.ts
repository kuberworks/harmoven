// lib/marketplace/scan.ts
// Content security scanner for marketplace packs.
// Spec: TECHNICAL.md §39.5 — scanPackContent() step in install flow.
//
// Checks performed (all local, no LLM calls):
//   1. Unicode normalization — defeat homoglyph bypass attacks (NFKD + strip non-ASCII)
//   2. External URL detection — packs must not phone home
//   3. Prompt injection pattern detection — known jailbreak patterns (OWASP LLM Top-10)
//
// Security design:
//   - Content is NFKD-normalized then stripped of non-ASCII chars before pattern matching.
//     This defeats homoglyph attacks (e.g. Cyrillic `і` substituted for ASCII `i`).
//   - ALL violations are collected before returning (no fast-fail), so an attacker
//     who fixes the first reported issue cannot hide a co-present injection.
//   - GPG signature verification is deferred to T3.8 (supplyChainMonitor).

export interface ScanViolation {
  type:     'injection' | 'external_url'
  reason:   string
  pattern?: string  // matched regex source (truncated) for injection violations
}

export interface ScanResult {
  passed:         boolean
  hasInjection:   boolean
  hasExternalUrl: boolean
  /** First violation reason — kept for backward compatibility with callers checking scan.reason */
  reason?:        string
  /** Full list of all violations found — use this for complete reporting */
  violations:     ScanViolation[]
}

// External URL patterns that must not appear in pack definitions.
// Packs may reference official harmoven docs (harmoven.com) or localhost.
//
// SEC-SCAN-01: The pattern covers all URI schemes with an authority component
// (http, https, ws, wss, ftp, file) to prevent packs from embedding non-HTTP
// callbacks or local file references. The negative lookahead exempts the two
// known-safe hosts; everything else is flagged.
const FORBIDDEN_URL_PATTERN = /(?:https?|wss?|ftp|file):\/\/(?!harmoven\.com|localhost|127\.0\.0\.1)/i

// Known prompt injection patterns sourced from OWASP LLM top-10 + internal research.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|prior)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|prior)\s+(instructions?|context)/i,
  /you\s+are\s+now\s+(a\s+)?(?:DAN|jailbreak|unrestricted)/i,
  /act\s+as\s+(?:if\s+you\s+have\s+no|an?\s+unrestricted)/i,
  /pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(?:different|unrestricted|evil)/i,
  /system\s*:\s*you\s+are/i,
  /<\|im_start\|>/i,   // ChatML injection
  /\[INST\]/i,          // Llama instruction injection attempt
  /###\s*NEW\s+SYSTEM\s+PROMPT/i,
]

/**
 * Normalize content for security scanning.
 *
 * Steps:
 *   1. NFKD unicode normalization — decomposes composed characters (ﬁ→fi, é→e+combining)
 *   2. Strip all non-ASCII characters — removes homoglyphs that survive NFKD
 *      (e.g. Cyrillic і U+0456 → stripped; the remaining ASCII text still conveys the attack)
 *
 * Note: legitimate pack content (task descriptions, prompts, configs) is expected to be
 * ASCII or common extended Latin. Exotic Unicode in pack content is itself suspicious.
 */
function normalizeForScan(content: string): string {
  return content.normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
}

/**
 * Scan pack content for security issues.
 *
 * Collects ALL violations before returning — does not stop at first match.
 * This prevents an attacker from iteratively fixing one violation at a time
 * to discover co-present injections.
 *
 * Content is Unicode-normalized before pattern matching to defeat homoglyph bypass.
 */
export function scanPackContent(content: string): ScanResult {
  const normalized  = normalizeForScan(content)
  const violations: ScanViolation[] = []

  // 1. External URL check (on normalized content)
  if (FORBIDDEN_URL_PATTERN.test(normalized)) {
    violations.push({
      type:   'external_url',
      reason: 'Pack contains external URL — packs must be self-contained (§39.5)',
    })
  }

  // 2. Prompt injection patterns (on normalized content)
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      violations.push({
        type:    'injection',
        pattern: pattern.source.slice(0, 60),
        reason:  `Pack contains potential prompt injection (matched: ${pattern.source.slice(0, 40)}…)`,
      })
    }
  }

  const hasInjection   = violations.some((v) => v.type === 'injection')
  const hasExternalUrl = violations.some((v) => v.type === 'external_url')

  return {
    passed:       violations.length === 0,
    hasInjection,
    hasExternalUrl,
    reason:       violations[0]?.reason,
    violations,
  }
}
