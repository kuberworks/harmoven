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
//   - Connections are cached by skillId to reuse stdio transport.
//   - callTool() throws SkillNotApprovedError for unapproved/disabled skills.

import { Client }               from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { db }                   from '@/lib/db/client'
import { mcpSkillEnv }          from '@/lib/utils/safe-env'

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

// ─── Connection cache ─────────────────────────────────────────────────────────
// One Client instance per skillId — reuses the stdio transport across calls.
// Entries are cleared on process restart (in-memory only).

const _clients = new Map<string, Client>()

/**
 * Return a connected MCP Client for the given skill.
 * Creates and caches the connection on first call.
 */
async function getClient(skillId: string): Promise<Client> {
  if (_clients.has(skillId)) return _clients.get(skillId)!

  const skill = await db.mcpSkill.findUnique({ where: { id: skillId } })
  if (!skill) throw new SkillNotApprovedError(skillId, 'not found')
  if (!skill.enabled) throw new SkillNotApprovedError(skillId, 'disabled')
  if (skill.scan_status !== 'passed') {
    throw new SkillNotApprovedError(skillId, `scan_status=${skill.scan_status}`)
  }

  const config = skill.config as unknown as McpSkillConfig

  const transport = new StdioClientTransport({
    command: config.command,
    args:    config.args ?? [],
    // mcpSkillEnv() provides safeBaseEnv() + declared vars only — never process.env spread.
    env:     mcpSkillEnv(config.env ?? {}),
  })

  const client = new Client({ name: 'harmoven', version: '1.0' })
  await client.connect(transport)
  _clients.set(skillId, client)
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
   */
  async disconnect(skillId: string): Promise<void> {
    const client = _clients.get(skillId)
    if (!client) return
    await client.close()
    _clients.delete(skillId)
  },
}
