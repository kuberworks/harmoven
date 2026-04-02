// lib/marketplace/static-safety-scan.ts
// Static safety scanner for marketplace imports (B.2.4).
//
// Applied to:
//   - package.json scripts, pre/post hooks
//   - .github/workflows/*.yml / Makefile / *.sh (visible in directory listing)
//   - .claude-plugin/plugin.json description + name (prompt injection only)
//   - commands/*.md bodies (prompt injection only)
//   - allowed_tools Bash patterns (shell injection only)
//   - README excerpts up to 2000 chars (prompt injection + YAML/bomb check)
//
// Security notes:
//   - All violations collected before returning (no fast-fail).
//   - Content sanitized to ASCII before pattern matching (homoglyph bypass prevention).
//   - Bash pattern parsing uses Bash\(([^)]+)\) to avoid colon-format bypass (SEC-28).

import { isMaliciousPackage } from './malicious-packages'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SafetyScanViolation =
  | { type: 'shell_injection'; pattern: string; detail: string }
  | { type: 'prompt_injection'; pattern: string; detail: string }
  | { type: 'malicious_dependency'; packageName: string }
  | { type: 'yaml_bomb' }
  | { type: 'repo_too_large' }
  | { type: 'content_too_large'; path: string }

export interface SafetyScanResult {
  passed: boolean
  violations: SafetyScanViolation[]
  /** Opaque summary safe to return to client (no pattern details). */
  clientSummary: string
}

// ─── Shell injection patterns (B.2.4) ────────────────────────────────────────

const SHELL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /rm\s+-rf\s+\//, label: 'rm -rf /' },
  { re: /curl\s+.*\|\s*(bash|sh|zsh)/, label: 'curl-pipe-shell' },
  { re: /wget\s+.*\|\s*(bash|sh|zsh)/, label: 'wget-pipe-shell' },
  { re: /eval\s*\(/, label: 'eval()' },
  { re: /exec\s*\(/, label: 'exec()' },
  { re: /process\.exit\s*\(/, label: 'process.exit()' },
  { re: /child_process\.(exec|spawn|execSync|spawnSync)\s*\(/, label: 'child_process' },
  { re: /require\(['"]child_process['"]\)/, label: 'require(child_process)' },
  { re: /__proto__\s*=/, label: '__proto__ mutation' },
  { re: /Object\.prototype\[/, label: 'Object.prototype mutation' },
]

// ─── Prompt injection patterns (B.2.4, extended to 2000-char window — L1) ────

const PROMPT_INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore\s+(previous|all)\s+instructions?/i, label: 'ignore-instructions' },
  { re: /you\s+are\s+now/i, label: 'you-are-now' },
  { re: /disregard\s+(previous|above|all)/i, label: 'disregard-instructions' },
  { re: /override\s+(system|user)\s+prompt/i, label: 'override-prompt' },
  { re: /jailbreak/i, label: 'jailbreak' },
  { re: /DAN\s+mode/i, label: 'DAN-mode' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip non-ASCII to defeat homoglyph bypass (same as scan.ts). */
function normalize(s: string): string {
  return s.normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run shell injection patterns against content.
 * Used for package.json scripts, shell files, CI yaml, Bash() allowed_tools patterns.
 */
export function runShellScan(content: string): SafetyScanViolation[] {
  const normalized = normalize(content)
  const violations: SafetyScanViolation[] = []
  for (const { re, label } of SHELL_PATTERNS) {
    if (re.test(normalized)) {
      violations.push({ type: 'shell_injection', pattern: label, detail: `Matched: ${label}` })
    }
  }
  return violations
}

/**
 * Run prompt injection patterns against content (max 2000 chars).
 * Used for README excerpts, descriptions, command bodies.
 * Applies only to the first 2000 characters (spec L1).
 */
export function runPromptInjectionScan(content: string): SafetyScanViolation[] {
  const excerpt = normalize(content.slice(0, 2000))
  const violations: SafetyScanViolation[] = []
  for (const { re, label } of PROMPT_INJECTION_PATTERNS) {
    if (re.test(excerpt)) {
      violations.push({ type: 'prompt_injection', pattern: label, detail: `Matched: ${label}` })
    }
  }
  return violations
}

/**
 * Parse Bash() allowed-tools format and run shell scan on extracted command.
 * Bash(command:subcommand:*) → extract inner content, then scan.
 * SEC-28: prevents colon-format bypass where space-based patterns would not match.
 */
export function runAllowedToolsScan(allowedTools: string[]): SafetyScanViolation[] {
  const violations: SafetyScanViolation[] = []
  const BASH_RE = /Bash\(([^)]+)\)/g
  for (const tool of allowedTools) {
    let match: RegExpExecArray | null
    BASH_RE.lastIndex = 0
    // eslint-disable-next-line no-cond-assign
    while ((match = BASH_RE.exec(tool)) !== null) {
      const cmd = match[1] ?? ''
      violations.push(...runShellScan(cmd))
    }
  }
  return violations
}

/**
 * Scan package.json dependencies against the malicious packages deny-list.
 */
export function runDependencyScan(
  dependencies: Record<string, string>,
): SafetyScanViolation[] {
  const violations: SafetyScanViolation[] = []
  for (const name of Object.keys(dependencies)) {
    if (isMaliciousPackage(name)) {
      violations.push({ type: 'malicious_dependency', packageName: name })
    }
  }
  return violations
}

/**
 * Full double-scan (B.2.4):
 * 1. Shell injection on raw content
 * 2. Prompt injection on content (up to 2000 chars)
 * Returns all collected violations.
 */
export function runDoubleScan(content: string): SafetyScanViolation[] {
  return [
    ...runShellScan(content),
    ...runPromptInjectionScan(content),
  ]
}

/**
 * YAML anchor/alias bomb check: count *alias occurrences.
 * If > 10 aliases, flag as a YAML bomb (B.2.4).
 */
export function checkYamlBomb(content: string): boolean {
  const aliasMatches = content.match(/\*/g)
  return (aliasMatches?.length ?? 0) > 10
}

/**
 * Aggregate full safety scan result with opaque client summary.
 */
export function buildScanResult(violations: SafetyScanViolation[]): SafetyScanResult {
  const passed = violations.length === 0
  const clientSummary = passed
    ? 'Scan passed'
    : `Scan failed: ${violations.length} violation(s) found`
  return { passed, violations, clientSummary }
}
