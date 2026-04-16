// lib/mcp/client.ts
// McpSkillClient — executes MCP tool calls for approved McpSkill records.
// Spec: TECHNICAL.md §12.2, V1_SCOPE "Pre-approved MCP Skills".
//
// Security:
//   - Only skills with scan_status='passed' AND enabled=true are executed.
//   - Every tool call is logged to AuditLog (tool name + run_id — never args).
//   - Tool content is wrapped in <EXTERNAL_TOOL_RESULT> tags for prompt
//     injection defence (Section 24 AGENTS-02).
//   - Subprocess env is constructed via mcpSkillEnv() — never process.env spread.
//   - Connections are cached by skillId with a hard TTL (SKILL_CACHE_TTL_MS).
//     Each callTool() re-validates enabled + scan_status in DB when the entry
//     has expired, ensuring that admin disable/revoke takes effect promptly.
//     Explicit disconnect() is always called when a skill is disabled via the
//     admin API (belt+suspenders with the TTL).
//   - callTool() throws SkillNotApprovedError for unapproved/disabled skills.
//   - config.command is validated against an allowlist at execution time
//     (CVE-HARM-005 defense-in-depth — belt+suspenders with admin-time validation).

import { Client }               from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path                     from 'node:path'
import { db }                   from '@/lib/db/client'
import { mcpSkillEnv }          from '@/lib/utils/safe-env'
import { uuidv7 }               from '@/lib/utils/uuidv7'

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpSkillConfig {
  /** Executable name — e.g. "npx", "python3". */
  command: string
  /** CLI arguments — e.g. ["-y", "n8n-mcp"]. */
  args?: string[]
  /** Declared environment variables (no secrets — credentials via vault). */
  env?: Record<string, string>
}

export class SkillNotApprovedError extends Error {
  constructor(skillId: string, reason: string) {
    super(`[McpSkillClient] Skill "${skillId}" is not usable: ${reason}`)
    this.name = 'SkillNotApprovedError'
  }
}

// ─── Command allowlist (CVE-HARM-005 defense-in-depth) ───────────────────────
// Imported from the shared allowlist — single source of truth.
// Also enforced at install time in app/api/admin/integrations/route.ts.
import { ALLOWED_MCP_COMMANDS } from '@/lib/mcp/validate-config'

// ─── Connection cache ─────────────────────────────────────────────────────────
// One Client instance per skillId — reuses the stdio transport across calls.
// Entries are cleared on process restart (in-memory only).
//
// SECURITY — TTL revalidation (SEC-MCP-01):
//   Each cache entry expires after SKILL_CACHE_TTL_MS. On expiry, getClient()
//   re-fetches the skill from DB before returning the cached connection.
//   This ensures that admin disable/revoke is enforced within TTL_MS even if
//   the caller forgot to call disconnect() explicitly.
//   5 minutes is chosen as the upper bound: short enough to be operationally
//   safe (admin disables a compromised skill → it stops being called within
//   5 min), long enough to not hammer the DB on frequent tool calls.

const SKILL_CACHE_TTL_MS = 5 * 60 * 1_000  // 5 minutes

interface CachedClient {
  client:    Client
  expiresAt: number
}

const _clients = new Map<string, CachedClient>()

/**
 * Return a connected MCP Client for the given skill.
 * Creates and caches the connection on first call.
 *
 * Re-validates skill state in DB when the cache entry has expired (TTL).
 * This guarantees that an admin disable/revoke takes effect within
 * SKILL_CACHE_TTL_MS even without an explicit disconnect() call.
 */
async function getClient(skillId: string): Promise<Client> {
  const cached = _clients.get(skillId)
  const now    = Date.now()

  if (cached) {
    // Cache hit within TTL — return immediately without a DB round-trip.
    if (now < cached.expiresAt) return cached.client

    // TTL expired — re-validate skill state before reusing the connection.
    // If the skill has been disabled or its scan_status regressed, evict and throw.
    const live = await db.mcpSkill.findUnique({
      where:  { id: skillId },
      select: { enabled: true, scan_status: true },
    })
    if (!live) {
      _clients.delete(skillId)
      await cached.client.close().catch(() => undefined)
      throw new SkillNotApprovedError(skillId, 'not found')
    }
    if (!live.enabled) {
      _clients.delete(skillId)
      await cached.client.close().catch(() => undefined)
      throw new SkillNotApprovedError(skillId, 'disabled')
    }
    if (live.scan_status !== 'passed') {
      _clients.delete(skillId)
      await cached.client.close().catch(() => undefined)
      throw new SkillNotApprovedError(skillId, `scan_status=${live.scan_status}`)
    }
    // Still valid — refresh the TTL and reuse the existing connection.
    cached.expiresAt = now + SKILL_CACHE_TTL_MS
    return cached.client
  }

  const skill = await db.mcpSkill.findUnique({ where: { id: skillId } })
  if (!skill) throw new SkillNotApprovedError(skillId, 'not found')
  if (!skill.enabled) throw new SkillNotApprovedError(skillId, 'disabled')
  if (skill.scan_status !== 'passed') {
    throw new SkillNotApprovedError(skillId, `scan_status=${skill.scan_status}`)
  }

  const config = skill.config as unknown as McpSkillConfig

  // Defense-in-depth: validate command at execution time.
  // Primary validation happens at install time; this catches legacy records.
  const cmdBasename = path.basename(config.command)
  if (!ALLOWED_MCP_COMMANDS.has(cmdBasename)) {
    throw new SkillNotApprovedError(
      skillId,
      `command "${config.command}" is not in the allowed executable list (${[...ALLOWED_MCP_COMMANDS].join(', ')})`,
    )
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args:    config.args ?? [],
    // mcpSkillEnv() provides safeBaseEnv() + declared vars only — never process.env spread.
    env:     mcpSkillEnv(config.env ?? {}),
  })

  const client = new Client({ name: 'harmoven', version: '1.0' })
  await client.connect(transport)
  _clients.set(skillId, { client, expiresAt: Date.now() + SKILL_CACHE_TTL_MS })
  return client
}

// ─── McpSkillClient ───────────────────────────────────────────────────────────

export const mcpSkillClient = {
  /**
   * Call an MCP tool on an approved skill.
   *
   * @param skillId  McpSkill.id (UUID)
   * @param toolName Tool name as listed in the skill's manifest
   * @param args     Tool arguments (JSON-serialisable)
   * @param runId    Parent run ID for audit log tracing
   *
   * @returns Tool output string, wrapped in EXTERNAL_TOOL_RESULT tags for
   *          prompt injection defence (Section 24 AGENTS-02).
   *
   * @throws SkillNotApprovedError when skill is not approved or disabled.
   */
  async callTool(
    skillId:  string,
    toolName: string,
    args:     Record<string, unknown>,
    runId:    string,
  ): Promise<string> {
    const client = await getClient(skillId)

    const result = await client.callTool({ name: toolName, arguments: args })

    // Log tool call to AuditLog — tool name + runId only; args NOT logged
    // (may contain sensitive data from the conversation context).
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        run_id:      runId,
        actor:       'system',
        action_type: 'mcp_tool_called',
        payload:     { skill_id: skillId, tool: toolName },
      },
    })

    // Extract text content from the MCP result.
    const rawContent = Array.isArray(result.content)
      ? result.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text?: string }) => c.text ?? '')
          .join('\n')
      : String(result.content ?? '')

    // Wrap in EXTERNAL_TOOL_RESULT tags — prompt injection defence.
    // Agents receive tool responses inside these tags so they cannot be
    // confused with system or user instructions (Section 24 AGENTS-02).
    return `<EXTERNAL_TOOL_RESULT skill="${skillId}" tool="${toolName}">\n${rawContent}\n</EXTERNAL_TOOL_RESULT>`
  },

  /**
   * Check which tools are available for a given skill (no execution).
   * Returns the MCP tools list from the skill's manifest.
   */
  async listTools(skillId: string): Promise<string[]> {
    const client = await getClient(skillId)
    const { tools } = await client.listTools()
    return tools.map((t: { name: string }) => t.name)
  },

  /**
   * Close the cached connection for a skill (e.g. after a skill update/disable).
   * Next call to callTool() will re-establish a fresh connection.
   *
   * Always call this when disabling a skill via the admin API so the effect
   * is immediate rather than waiting for the TTL to expire.
   */
  async disconnect(skillId: string): Promise<void> {
    const cached = _clients.get(skillId)
    if (!cached) return
    _clients.delete(skillId)
    await cached.client.close().catch(() => undefined)
  },
}
