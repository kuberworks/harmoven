// lib/utils/safe-env.ts
// Explicit environment variable whitelists for child processes.
// Spec: Amendment 92 H1 — process.env spread blocked.
//
// Problem: `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }` leaks ALL env vars
// (DATABASE_URL, AUTH_SECRET, ENCRYPTION_KEY, all LLM API keys) to every
// child process. A compromised subprocess can read them trivially.
//
// Fix: explicit whitelists — each caller gets ONLY what it needs.
// Never use: { ...process.env, ... } in execFile options.
//
// Security:
//   - PATH and HOME are OS-level values (not secrets) — safe to pass
//   - DATABASE_URL, AUTH_SECRET, *_API_KEY are NEVER in any child env
//   - LLM keys are passed only via CredentialVault ephemeral tokens (T3.9)

// ─── Base whitelist ───────────────────────────────────────────────────────────

/**
 * Minimal safe environment for child processes.
 * Contains only OS path+locale essentials — no secrets, no API keys.
 */
export function safeBaseEnv(): Record<string, string> {
  return {
    PATH:   process.env.PATH   ?? '/usr/local/bin:/usr/bin:/bin',
    HOME:   process.env.HOME   ?? '/tmp',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG:   process.env.LANG   ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
    // Explicitly NOT included:
    //   DATABASE_URL, AUTH_SECRET, ENCRYPTION_KEY
    //   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY
    //   AUTH_SKIP_VERIFY, NODE_ENV (not needed by subprocesses)
  }
}

import { assertSafePath } from '@/lib/utils/input-validation'

// ─── Git environment ──────────────────────────────────────────────────────────

/**
 * Environment for git subprocess calls.
 * Disables interactive prompts (GIT_TERMINAL_PROMPT=0) — prevents hangs.
 * Stamped author/committer identity for config-git commits.
 *
 * @param extras  Optional additional safe vars (validated by caller)
 */
export function gitEnv(
  extras: Record<string, string> = {},
): Record<string, string> {
  return {
    ...safeBaseEnv(),
    GIT_TERMINAL_PROMPT: '0',         // never prompt for credentials
    GIT_AUTHOR_NAME:     'Harmoven',
    GIT_AUTHOR_EMAIL:    'git@harmoven.local',
    GIT_COMMITTER_NAME:  'Harmoven',
    GIT_COMMITTER_EMAIL: 'git@harmoven.local',
    ...extras,  // only caller-provided, validated extras — not process.env spread
  }
}

/**
 * Environment for git operations over SSH.
 * Adds a GIT_SSH_COMMAND pointing to a specific key file.
 * StrictHostKeyChecking=accept-new: accept unknown hosts automatically
 * (suitable for internal infra); BatchMode prevents interactive prompts.
 *
 * SECURITY: assertSafePath() is enforced internally — callers do NOT need to
 * validate keyFile separately. This prevents command injection if the caller
 * forgets validation (Amendment 92 C1 — no shell-interpolated dynamic values).
 *
 * @param keyFile  Absolute path to the SSH private key
 */
export function gitSshEnv(keyFile: string): Record<string, string> {
  // Enforce path safety before inserting into a shell-interpreted string.
  // GIT_SSH_COMMAND is passed through the shell by some Git versions.
  assertSafePath(keyFile)
  return gitEnv({
    GIT_SSH_COMMAND: `ssh -i ${keyFile} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
  })
}

// ─── LLM runner environment ───────────────────────────────────────────────────

/**
 * Environment for the Kilo CLI (or similar LLM subprocess).
 * Receives ONLY the single provider key it needs — from CredentialVault.
 * No DATABASE_URL, no AUTH_SECRET.
 *
 * @param providerKey  Ephemeral token from CredentialVault (run-scoped)
 */
export function kiloEnv(providerKey: string): Record<string, string> {
  return {
    ...safeBaseEnv(),
    ANTHROPIC_API_KEY: providerKey,  // ephemeral — from CredentialVault
  }
}

// ─── MCP skill environment ────────────────────────────────────────────────────

/**
 * Environment for MCP skill child processes.
 * Only the vars declared in the skill's manifest are passed — nothing extra.
 *
 * @param declared  Map of env var name → value from the skill manifest.
 *                  Callers must validate names and values before passing.
 */
export function mcpSkillEnv(
  declared: Record<string, string>,
): Record<string, string> {
  return {
    ...safeBaseEnv(),
    ...declared,  // only the vars the skill explicitly declared — no wild spread
  }
}

// ─── npm/node environment (worktree builds) ───────────────────────────────────

/**
 * Environment for npm/node invocations in generated worktrees.
 * NOTE: --ignore-scripts must always be passed as an argument in addition to
 * this env — this env does not enforce it.
 */
export function nodeEnv(
  cwd: string,
  extras: Record<string, string> = {},
): Record<string, string> {
  return {
    ...safeBaseEnv(),
    NODE_ENV: 'production',
    npm_config_ignore_scripts: 'true',  // defence-in-depth: also pass --ignore-scripts
    ...extras,
  }
}
