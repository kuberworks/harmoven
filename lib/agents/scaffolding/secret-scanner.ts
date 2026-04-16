// lib/agents/scaffolding/secret-scanner.ts
// Secret scanner for generated worktrees — Amendment 92 M2.
//
// Runs AFTER Layer Agents complete, BEFORE Human Gate delivery.
// Uses gitleaks to detect secrets accidentally generated into application code.
//
// Security:
//   - gitleaks is invoked via execFile() — no shell interpolation.
//   - worktreePath validated with assertSafePath() before use.
//   - --redact flag: secret values are replaced with REDACTED in output.
//   - --exit-code 0: process never fails; findings are returned as data.
//   - Results are warnings only — the gate can block but the scanner doesn't.
//
// gitleaks must be pre-installed in the Docker image and pinned by digest
// (see docker-compose.yml, which pulls gitleaks via the base image).

import { execFileAsync } from '@/lib/utils/exec-safe'
import { assertSafePath } from '@/lib/utils/input-validation'
import { safeBaseEnv }    from '@/lib/utils/safe-env'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SecretFinding {
  /** File path relative to the worktree root */
  file:       string
  /** 1-based line number */
  line:       number
  /** Rule type: 'api_key' | 'private_key' | 'password' | 'generic_secret' | ... */
  type:       string
  confidence: 'high' | 'medium' | 'low'
  /**
   * Non-sensitive preview — first 20 chars of the matched line with the
   * actual secret value REDACTED by gitleaks (--redact flag).
   */
  preview:    string
}

export interface ScanResult {
  findings:  SecretFinding[]
  scannedAt: string  // ISO timestamp
  /** True if gitleaks binary was not found — non-fatal, just skip */
  skipped:   boolean
  /** Raw error message if scan failed for a non-gitleaks-missing reason */
  error?:    string
}

// ─── gitleaks output schema (subset) ─────────────────────────────────────────

interface GitleaksRawFinding {
  File?:       string
  StartLine?:  number
  RuleID?:     string
  Description?: string
  Entropy?:    number
  Secret?:     string  // REDACTED by --redact
  Match?:      string
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a generated worktree directory for secrets using gitleaks.
 *
 * @param worktreePath  Absolute path to the generated app worktree.
 *                      Must not contain ".." (assertSafePath validated).
 * @returns ScanResult — never throws.
 */
export async function scanWorktreeForSecrets(
  worktreePath: string,
): Promise<ScanResult> {
  const scannedAt = new Date().toISOString()

  // Validate path before passing to execFile
  try {
    assertSafePath(worktreePath)
  } catch (e) {
    return {
      findings:  [],
      scannedAt,
      skipped:   false,
      error:     `Invalid worktree path: ${(e as Error).message}`,
    }
  }

  let stdout = ''
  try {
    const result = await execFileAsync(
      'gitleaks',
      [
        'detect',
        '--source',        worktreePath,
        '--no-git',        // scan files, not git history
        '--report-format', 'json',
        '--report-path',   '/dev/stdout',
        '--redact',        // replace secret values with REDACTED
        '--exit-code',     '0',  // never fail the process
      ],
      {
        timeout: 60_000,  // 1 minute max for scanning
      }
    )
    stdout = result.stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    // gitleaks binary not found — non-fatal
    if (err.code === 'ENOENT') {
      return { findings: [], scannedAt, skipped: true }
    }
    return {
      findings: [],
      scannedAt,
      skipped:  false,
      error:    err.message,
    }
  }

  // Parse JSON output
  let raw: GitleaksRawFinding[] = []
  try {
    raw = JSON.parse(stdout || '[]') as GitleaksRawFinding[]
    if (!Array.isArray(raw)) raw = []
  } catch {
    return {
      findings: [],
      scannedAt,
      skipped:  false,
      error:    'Failed to parse gitleaks JSON output',
    }
  }

  const findings: SecretFinding[] = raw.map(item => ({
    file:       sanitizeString(item.File),
    line:       typeof item.StartLine === 'number' ? item.StartLine : 0,
    type:       sanitizeString(item.RuleID ?? item.Description),
    confidence: classifyConfidence(item.Entropy),
    preview:    sanitizeString(item.Match ?? item.Secret).slice(0, 80),
  }))

  return { findings, scannedAt, skipped: false }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeString(val: unknown): string {
  if (typeof val !== 'string') return ''
  // Remove control characters and null bytes before returning
  return val.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500)
}

function classifyConfidence(entropy?: number): SecretFinding['confidence'] {
  if (entropy === undefined) return 'medium'
  if (entropy >= 4.5) return 'high'
  if (entropy >= 3.5) return 'medium'
  return 'low'
}

/**
 * Format scan findings as a human-readable warning block for HANDOFF_NOTE.
 * Does NOT include the secret values (redacted by gitleaks).
 */
export function formatScanWarning(result: ScanResult): string | null {
  if (result.skipped) return null
  if (result.findings.length === 0) return null

  const lines = [
    `⚠ Secret Scanner found ${result.findings.length} potential secret(s):`,
  ]
  for (const f of result.findings) {
    lines.push(`  - ${f.file}:${f.line} — ${f.type} (${f.confidence} confidence)`)
  }
  lines.push('Review these before committing to a public repository.')
  return lines.join('\n')
}
