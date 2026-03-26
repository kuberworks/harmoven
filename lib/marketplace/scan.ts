// lib/marketplace/scan.ts
// Content security scanner for marketplace packs.
// Spec: TECHNICAL.md §39.5 — scanPackContent() step in install flow.
//
// Checks performed (all local, no LLM calls):
//   1. External URL detection — packs must not phone home
//   2. Prompt injection pattern detection — known jailbreak patterns
//   3. Forbidden instruction detection — "ignore previous instructions" etc.
//
// GPG signature verification is deferred to T3.8 (supplyChainMonitor).

export interface ScanResult {
  passed:         boolean
  hasInjection:   boolean
  hasExternalUrl: boolean
  reason?:        string
}

// External URL patterns that must not appear in pack definitions.
// Packs may reference official harmoven docs (harmoven.com) or localhost.
const FORBIDDEN_URL_PATTERN = /https?:\/\/(?!harmoven\.com|localhost|127\.0\.0\.1)/i

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
 * Scan pack content for security issues.
 * Returns immediately on first failure — does not accumulate all violations.
 */
export function scanPackContent(content: string): ScanResult {
  // 1. Check for external URLs (packs must be self-contained)
  if (FORBIDDEN_URL_PATTERN.test(content)) {
    return {
      passed:         false,
      hasInjection:   false,
      hasExternalUrl: true,
      reason:         'Pack contains external URL — packs must be self-contained (§39.5)',
    }
  }

  // 2. Check for prompt injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return {
        passed:       false,
        hasInjection: true,
        hasExternalUrl: false,
        reason:       `Pack contains potential prompt injection pattern (matched: ${pattern.source.slice(0, 40)}…)`,
      }
    }
  }

  return { passed: true, hasInjection: false, hasExternalUrl: false }
}
