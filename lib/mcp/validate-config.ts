// lib/mcp/validate-config.ts
// Shared MCP skill config validator — used at admin-time (install + update routes).
//
// CVE-HARM-005: prevents arbitrary binary execution via the MCP stdio transport.
// An admin (or a compromised admin account) registering command: "/bin/bash"
// would obtain RCE through the MCP StdioClientTransport. This allowlist ensures
// only well-known package runners and interpreters can be specified.
//
// SEC-HARM-011: prevents inline code execution via interpreter flags.
// node -e "...", python3 -c "...", bun -e "...", deno eval "..." etc. allow
// arbitrary code execution even when the command basename is on the allowlist.
// These flags are therefore explicitly blocked.
//
// Also enforced at execution time in lib/mcp/client.ts (belt-and-suspenders).

/**
 * Executables an MCP skill manifest may specify as `command`.
 * Only the basename is matched — absolute paths are rejected.
 */
export const ALLOWED_MCP_COMMANDS = new Set([
  'npx', 'node', 'nodejs',
  'python', 'python3',
  'uvx', 'uv',
  'deno',
  'bun',
])

/**
 * Argument flags that trigger inline code execution on common interpreters.
 * Blocking these prevents CVE-HARM-005 bypass via `node -e "..."` etc.
 *
 * Normalised to lowercase for comparison.
 */
const INLINE_EVAL_FLAGS = new Set([
  // Node.js / Bun
  '-e', '--eval', '-p', '--print',
  // Python
  '-c',
  // Deno
  'eval',
  // Generic shell-like
  '-x', '--execute', '--run',
])

/**
 * Validate a skill config object.
 *
 * @returns null if valid, or an error string describing the problem.
 */
export function validateMcpConfig(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null
  const c = config as Record<string, unknown>

  if ('command' in c) {
    const cmd      = String(c['command'] ?? '')
    // Reject absolute paths and traversal attempts — only compare the basename.
    const basename = cmd.split('/').pop()?.split('\\').pop() ?? cmd
    if (!ALLOWED_MCP_COMMANDS.has(basename)) {
      return (
        `MCP skill command "${cmd}" is not in the allowed executable list. `
        + `Allowed: ${[...ALLOWED_MCP_COMMANDS].join(', ')}`
      )
    }
  }

  if ('args' in c && Array.isArray(c['args'])) {
    if ((c['args'] as unknown[]).length > 32) {
      return 'args array exceeds maximum length of 32'
    }
    for (const arg of c['args'] as unknown[]) {
      if (typeof arg !== 'string') return 'all args must be strings'
      // SEC-HARM-011: block inline-eval flags that allow arbitrary code execution
      // even when the command is on the allowlist (e.g. node -e "require('child_process')...").
      const normalised = arg.trim().toLowerCase()
      if (INLINE_EVAL_FLAGS.has(normalised)) {
        return (
          `MCP skill arg "${arg}" is a code-execution flag and is not allowed. `
          + `Use a proper entry-point file instead.`
        )
      }
    }
  }

  return null
}
