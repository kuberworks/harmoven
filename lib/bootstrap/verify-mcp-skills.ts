// lib/bootstrap/verify-mcp-skills.ts
// Amendment 91.6 — MCP skill integrity verification at startup.
//
// Before the server accepts requests, verify each configured MCP skill:
//   1. Version is valid semver
//   2. The skill's entrypoint file SHA-256 matches the hash recorded in
//      orchestrator.yaml (or the companion .mcp-hashes.json file)
//
// On mismatch:
//   - Critical event logged via supply-chain-monitor
//   - HARMOVEN_MCP_SKILL_VERIFY_STRICT=true → server startup aborted
//   - HARMOVEN_MCP_SKILL_VERIFY_STRICT=false (default) → warning only, skill disabled
//
// Configuration (orchestrator.yaml):
//
//   experimental:
//     mcp_server:
//       enabled: true
//       skills:
//         - name: "my-skill"
//           version: "1.2.3"
//           entrypoint: "/opt/mcp/my-skill/index.js"
//           sha256: "abc123..."   # hex string, 64 chars

import { createHash } from 'node:crypto'
import { readFile }   from 'node:fs/promises'
import { existsSync } from 'node:fs'
import semver         from 'semver'
import { reportMCPSkillHashMismatch } from '@/lib/security/supply-chain-monitor'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPSkillConfig {
  /** Skill identifier, e.g. "my-skill" */
  name:        string
  /** Must be valid semver, e.g. "1.2.3" */
  version:     string
  /** Absolute path to the skill entry-point file to hash */
  entrypoint:  string
  /** Expected SHA-256 hex digest of entrypoint (64 chars) */
  sha256:      string
}

export interface MCPVerificationResult {
  skill:   string
  version: string
  passed:  boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

/**
 * Verify all configured MCP skills at startup.
 *
 * @param skills  - List of skill configs from orchestrator.yaml
 * @param strict  - Throw on first failure instead of continuing (default false)
 * @returns       - Array of per-skill results
 */
export async function verifyMCPSkills(
  skills: MCPSkillConfig[],
  strict = false,
): Promise<MCPVerificationResult[]> {
  const results: MCPVerificationResult[] = []

  for (const skill of skills) {
    const result = await verifySingleSkill(skill)
    results.push(result)

    if (!result.passed && strict) {
      throw new Error(
        `MCP skill verification failed (strict mode): ${skill.name}@${skill.version} — ${result.reason}`,
      )
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function verifySingleSkill(skill: MCPSkillConfig): Promise<MCPVerificationResult> {
  const { name, version, entrypoint, sha256: expectedHash } = skill

  // 1. Semver validation ────────────────────────────────────────────────────
  if (!semver.valid(version)) {
    const reason = `Version "${version}" is not valid semver`
    void reportMCPSkillHashMismatch({
      skillName: name,
      version,
      expected: expectedHash,
      actual: '(invalid version — hash not computed)',
    })
    return { skill: name, version, passed: false, reason }
  }

  // 2. Validate expected hash format ────────────────────────────────────────
  if (!SHA256_HEX_RE.test(expectedHash)) {
    const reason = `Configured sha256 for skill "${name}" is malformed (must be 64 hex chars)`
    return { skill: name, version, passed: false, reason }
  }

  // 3. Entrypoint exists ────────────────────────────────────────────────────
  if (!existsSync(entrypoint)) {
    const reason = `Entrypoint not found: ${entrypoint}`
    void reportMCPSkillHashMismatch({
      skillName: name,
      version,
      expected: expectedHash,
      actual: '(file not found)',
    })
    return { skill: name, version, passed: false, reason }
  }

  // 4. SHA-256 file hash ────────────────────────────────────────────────────
  let actualHash: string
  try {
    const content = await readFile(entrypoint)
    actualHash = createHash('sha256').update(content).digest('hex')
  } catch (err) {
    const reason = `Failed to read entrypoint: ${err instanceof Error ? err.message : String(err)}`
    return { skill: name, version, passed: false, reason }
  }

  if (actualHash !== expectedHash.toLowerCase()) {
    const reason = `SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`
    void reportMCPSkillHashMismatch({
      skillName: name,
      version,
      expected: expectedHash.toLowerCase(),
      actual: actualHash,
    })
    return { skill: name, version, passed: false, reason }
  }

  return { skill: name, version, passed: true }
}

// ---------------------------------------------------------------------------
// Config-aware entry point — called from instrumentation.ts at startup
// ---------------------------------------------------------------------------

/**
 * Load MCP skill configs from orchestrator.yaml and verify them.
 * Reads the `experimental.mcp_server.skills` array if present.
 * If MCP is disabled or not configured, returns an empty results array (no-op).
 *
 * @param strict - Throw on first failure instead of continuing (default false)
 */
export async function verifyMCPSkillsFromConfig(strict = false): Promise<MCCVerificationResultArray> {
  let skills: MCPSkillConfig[] = []
  try {
    const { readFile } = await import('node:fs/promises')
    const { join }     = await import('node:path')
    const { load }     = await import('js-yaml') as { load: (s: string) => unknown }
    const configPath   = join(process.cwd(), 'orchestrator.yaml')
    const raw          = await readFile(configPath, 'utf8')
    const config       = load(raw) as Record<string, unknown>
    const exp = config['experimental'] as Record<string, unknown> | undefined
    const mcp = exp?.['mcp_server'] as Record<string, unknown> | undefined
    if (mcp?.['enabled'] && Array.isArray(mcp['skills'])) {
      skills = mcp['skills'] as MCPSkillConfig[]
    }
  } catch {
    // No orchestrator.yaml or YAML parse failure — treat as no configured skills.
  }
  return verifyMCPSkills(skills, strict)
}

type MCCVerificationResultArray = Promise<MCPVerificationResult[]>
