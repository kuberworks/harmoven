// lib/utils/exec-safe.ts
// Safe subprocess execution utility — Amendment 92 (Am.83 × Am.92).
//
// SECURITY: Never use exec() with string interpolation — command injection risk.
// All subprocess calls MUST use execFileAsync() + assertSafe*() validators.
//
// Rules:
//   - execFileAsync() uses child_process.execFile — args are passed as an array,
//     never shell-interpolated. No shell metacharacter injection possible.
//   - git/path values must be validated with assertSafeRef/assertSafePath from
//     lib/utils/input-validation.ts before being passed as arguments.
//   - exec() with template literals is banned via ESLint no-restricted-syntax.
//   - Never pass { ...process.env } to child processes — use safeBaseEnv() from
//     lib/utils/safe-env.ts instead.

import { execFile }  from 'child_process'
import { promisify } from 'util'
import {
  assertSafeRef,
  assertSafeBranchName,
  assertSafePath as assertSafePathShared,
  assertSafeUrl,
}  from '@/lib/utils/input-validation'
import { gitEnv, gitSshEnv } from '@/lib/utils/safe-env'

export { assertSafeRef, assertSafeBranchName, assertSafeUrl } from '@/lib/utils/input-validation'

const execFilePromise = promisify(execFile)

export interface ExecResult {
  stdout: string
  stderr: string
}

/**
 * Run a command without a shell — arguments are passed as an array,
 * preventing any shell interpolation or injection.
 *
 * @param file    The executable (e.g. 'git')
 * @param args    Argument array — never concatenated into a shell string
 * @param options Optional cwd and timeout
 */
export async function execFileAsync(
  file:    string,
  args:    string[],
  options: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> } = {},
): Promise<ExecResult> {
  const { stdout, stderr } = await execFilePromise(file, args, {
    cwd:     options.cwd,
    timeout: options.timeout ?? 30_000,   // 30 s default — git ops are fast
    // Use caller-supplied env or fall back to git env (never full process.env)
    env: options.env ?? gitEnv(),
  })
  return { stdout: stdout.toString(), stderr: stderr.toString() }
}

/**
 * Assert that a path is safe to pass to git commands.
 * Re-exports the shared version from input-validation.ts.
 * Kept here for backwards compatibility with callers that import from exec-safe.
 */
export function assertSafePath(p: string): string {
  assertSafePathShared(p)  // throws ValidationError on failure
  return p
}

// ─── High-level git operation helpers ────────────────────────────────────────

/**
 * Clone a git repository at a specific ref.
 * All arguments validated before use.
 */
export async function gitClone(
  url:     string,
  workDir: string,
  ref:     string,
): Promise<void> {
  assertSafeUrl(url)
  assertSafeRef(ref)
  assertSafePathShared(workDir)
  await execFileAsync('git', [
    'clone',
    '--depth', '1',
    '--single-branch',
    '--branch', ref,
    url,
    workDir,
  ], { env: gitEnv() })
}

/**
 * Create a git worktree at a new path with a new branch.
 */
export async function gitWorktreeAdd(
  repoPath:     string,
  worktreePath: string,
  branchName:   string,
): Promise<void> {
  assertSafePathShared(repoPath)
  assertSafePathShared(worktreePath)
  assertSafeBranchName(branchName)
  await execFileAsync('git', [
    '-C', repoPath,
    'worktree', 'add',
    worktreePath,
    '-b', branchName,
  ], { env: gitEnv() })
}
