// lib/utils/exec-safe.ts
// Safe subprocess execution utility — Amendment 94.4 (Am.83 × Am.92).
//
// SECURITY: Never use exec() with string interpolation — command injection risk.
// All git operations in config-git/ MUST use execFileAsync() exclusively.
//
// Rules:
//   - execFileAsync() uses child_process.execFile — args are passed as an array,
//     never shell-interpolated. No shell metacharacter injection possible.
//   - assertSafePath() validates filesystem paths before passing to execFile:
//       no null bytes, no '..' traversal segments, non-empty.
//   - Both functions are intentionally small and reviewable.

import { execFile }  from 'child_process'
import { promisify } from 'util'
import path          from 'path'

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
  options: { cwd?: string; timeout?: number } = {},
): Promise<ExecResult> {
  const { stdout, stderr } = await execFilePromise(file, args, {
    cwd:     options.cwd,
    timeout: options.timeout ?? 30_000,   // 30 s default — git ops are fast
    // Do not inherit shell env wholesale; pass only what git needs
    env: {
      HOME:        process.env.HOME,
      PATH:        process.env.PATH,
      GIT_AUTHOR_NAME:    'Harmoven',
      GIT_AUTHOR_EMAIL:   'config@harmoven.local',
      GIT_COMMITTER_NAME: 'Harmoven',
      GIT_COMMITTER_EMAIL:'config@harmoven.local',
    },
  })
  return { stdout: stdout.toString(), stderr: stderr.toString() }
}

/**
 * Assert that a path is safe to pass to git commands:
 *   - Non-empty string
 *   - No null bytes (binary injection)
 *   - No '..' traversal segments after normalization
 *
 * Throws if the path fails any check.
 * Returns the path unchanged on success.
 */
export function assertSafePath(p: string): string {
  if (!p || typeof p !== 'string') {
    throw new Error('[execSafe] Path must be a non-empty string')
  }
  if (p.includes('\0')) {
    throw new Error(`[execSafe] Path contains null byte: "${p}"`)
  }
  // Check raw segments BEFORE normalization — catches '../' that normalize() resolves away
  const rawSegments = p.split(/[\/\\]/)
  if (rawSegments.includes('..')) {
    throw new Error(`[execSafe] Path traversal detected in: "${p}"`)
  }
  return p
}
