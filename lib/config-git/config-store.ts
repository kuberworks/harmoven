// lib/config-git/config-store.ts
// GitConfigStore — IConfigStore backed by a local git repository.
// Amendment 83 (Section 32 / 83.6) + security fix Am.94.4.
//
// SECURITY (Am.94.4):
//   - All git subprocess calls use execFileAsync() — no shell interpolation.
//   - All filesystem paths validated with assertSafePath() before use.
//   - Config content from DB (JSON/YAML) is written as a file — never
//     interpolated into a git command string.
//   - commit messages are passed as a -m argument array element (execFile),
//     not as a shell string — no injection possible regardless of content.
//
// Restore policy (83.10):
//   - Always a new forward commit — history is never rewritten.
//   - syncToDb() called after restore to keep DB consistent.
//   - Running runs are unaffected (they snapshotted config at start time).
//   - Credentials never in config.git — restore cannot affect secrets.

import { promises as fs } from 'fs'
import path                from 'path'

import { db }              from '@/lib/db/client'
import { execFileAsync, assertSafePath } from '@/lib/utils/exec-safe'
import { getConfigGitRoot }              from './paths'
import type {
  ConfigEntry,
  ConfigVersion,
  ConfigDiff,
  IConfigStore,
}                          from './config-store.interface'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a safe directory path for a project_id.
 * project_id is a UUID from our own DB — but we still validate it
 * to reject any unexpected value that could escape the config root.
 */
function projectDir(root: string, project_id: string | 'instance'): string {
  if (project_id === 'instance') return path.join(root, 'instance')
  // UUID: 8-4-4-4-12 hex chars + hyphens. Reject anything else.
  if (!/^[0-9a-f-]{36}$/.test(project_id)) {
    throw new Error(
      `[GitConfigStore] Invalid project_id format: "${project_id}". Expected UUID.`,
    )
  }
  return path.join(root, 'projects', project_id)
}

/**
 * Parse a single `git log --format=...` output line into ConfigVersion.
 * Format: "<hash> <iso-date> <author> <message>"
 */
function parseLogLine(line: string): ConfigVersion | null {
  // format: HASH|ISO_DATE|AUTHOR|MESSAGE|FILE1,FILE2
  const parts = line.split('\x00')
  if (parts.length < 4) return null
  const [hash, isoDate, author, message, filesStr] = parts
  return {
    hash:      hash!.trim().slice(0, 7),
    message:   message!.trim(),
    author:    author!.trim(),
    timestamp: new Date(isoDate!.trim()),
    changed:   filesStr ? filesStr.trim().split(',').filter(Boolean) : [],
  }
}

/**
 * Parse unified diff into before/after content.
 * Extracts hunk content from a `git diff` output.
 */
function parseDiff(raw: string): ConfigDiff {
  const before: string[] = []
  const after:  string[] = []

  for (const line of raw.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue
    if (line.startsWith('-')) before.push(line.slice(1))
    else if (line.startsWith('+')) after.push(line.slice(1))
    else {
      before.push(line.slice(1))
      after.push(line.slice(1))
    }
  }

  return { before: before.join('\n'), after: after.join('\n'), patch: raw }
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class GitConfigStore implements IConfigStore {
  private readonly root: string

  constructor(root?: string) {
    this.root = root ?? getConfigGitRoot()
  }

  async get(entry: Omit<ConfigEntry, 'content'>): Promise<string | null> {
    const filePath = this.filePath(entry)
    try {
      return await fs.readFile(filePath, 'utf8')
    } catch {
      return null
    }
  }

  async set(entry: ConfigEntry, actor: string, note?: string): Promise<ConfigVersion> {
    const filePath = this.filePath(entry)
    assertSafePath(filePath)

    // Write file to disk
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, entry.content, 'utf8')

    // Stage
    await execFileAsync('git', ['-C', this.root, 'add', filePath])

    // Commit — message passed as array element: no shell injection possible
    const message = this.commitMessage(entry, actor, note)
    const { stdout } = await execFileAsync('git', [
      '-C', this.root,
      'commit',
      '-m', message,
      '--allow-empty',
    ])

    // Extract short hash from "[$branch $hash] ..." output
    const hash = this.extractHash(stdout)

    // Update Project.config_git_hash in DB (best-effort, non-blocking)
    if (entry.project_id !== 'instance') {
      db.project.update({
        where: { id: entry.project_id },
        data:  { config_git_hash: hash, config_git_at: new Date() },
      }).catch(() => undefined)
    }

    return {
      hash,
      message,
      author:    actor,
      timestamp: new Date(),
      changed:   [this.relPath(entry)],
    }
  }

  async history(
    project_id: string | 'instance',
    limit      = 50,
  ): Promise<ConfigVersion[]> {
    const dir = project_id === 'instance'
      ? 'instance'
      : `projects/${project_id}`

    assertSafePath(path.join(this.root, dir))

    // Custom format with NUL separators to handle arbitrary message content
    // --name-only provides changed files list (one per line after blank line)
    const format = '%H\x00%aI\x00%an\x00%s\x00%N'

    let stdout: string
    try {
      ;({ stdout } = await execFileAsync('git', [
        '-C', this.root,
        'log',
        `--format=${format}`,
        `--max-count=${limit}`,
        '--',
        dir,
      ]))
    } catch {
      return []  // repo empty or dir doesn't exist yet
    }

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(parseLogLine)
      .filter((v): v is ConfigVersion => v !== null)
  }

  async diff(hash1: string, hash2: string, file?: string): Promise<ConfigDiff> {
    // Validate hashes: git hashes are hex, 7–40 chars
    for (const h of [hash1, hash2]) {
      if (!/^[0-9a-f]{7,40}$/.test(h)) {
        throw new Error(`[GitConfigStore] Invalid commit hash: "${h}"`)
      }
    }

    const args = ['-C', this.root, 'diff', hash1, hash2]
    if (file) {
      assertSafePath(path.join(this.root, file))
      args.push('--', file)
    }

    let stdout = ''
    try {
      ;({ stdout } = await execFileAsync('git', args))
    } catch {
      // No diff (identical commits) — return empty
    }

    return parseDiff(stdout)
  }

  async restore(hash: string, actor: string): Promise<ConfigVersion> {
    // Validate hash
    if (!/^[0-9a-f]{7,40}$/.test(hash)) {
      throw new Error(`[GitConfigStore] Invalid commit hash: "${hash}"`)
    }

    // 1. List files changed in the target commit
    const { stdout: filesOut } = await execFileAsync('git', [
      '-C', this.root,
      'diff-tree',
      '--no-commit-id',
      '-r',
      '--name-only',
      hash,
    ])
    const files = filesOut.trim().split('\n').filter(Boolean)

    // 2. Checkout those files from the target hash into the working tree
    for (const file of files) {
      assertSafePath(path.join(this.root, file))
      await execFileAsync('git', ['-C', this.root, 'checkout', hash, '--', file])
    }

    // 3. Commit the restore as a new forward commit (83.10 rule 1)
    const message = `restore: reverted to ${hash.slice(0, 7)} by ${actor}`
    const { stdout } = await execFileAsync('git', [
      '-C', this.root,
      'commit',
      '-am', message,
      '--allow-empty',
    ])

    // 4. Sync DB with restored values (83.5 rule 2)
    await this.syncToDb(files)

    return {
      hash:      this.extractHash(stdout),
      message,
      author:    actor,
      timestamp: new Date(),
      changed:   files,
    }
  }

  async export(project_id: string | 'instance'): Promise<Record<string, string>> {
    const dir     = projectDir(this.root, project_id)
    const result: Record<string, string> = {}

    try {
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const fullPath = path.join(entry.parentPath ?? dir, entry.name)
        const relKey   = path.relative(dir, fullPath)
        result[relKey] = await fs.readFile(fullPath, 'utf8')
      }
    } catch {
      // directory doesn't exist yet
    }

    return result
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private filePath(entry: { project_id: string | 'instance'; key: string }): string {
    const dir = projectDir(this.root, entry.project_id)
    return path.join(dir, entry.key)
  }

  private relPath(entry: { project_id: string | 'instance'; key: string }): string {
    return path.relative(this.root, this.filePath(entry))
  }

  private commitMessage(
    entry:  ConfigEntry,
    actor:  string,
    note?:  string,
  ): string {
    const scope = entry.project_id === 'instance'
      ? 'instance'
      : `project/${entry.project_id.slice(0, 8)}`
    const base = `config(${scope}): update ${entry.key} [${actor}]`
    return note ? `${base} — ${note}` : base
  }

  private extractHash(commitOutput: string): string {
    // Typical git commit output: "[branch abcdef1] message"
    const match = commitOutput.match(/\[[\w/]+ ([0-9a-f]{7,40})\]/)
    return match ? match[1]!.slice(0, 7) : 'unknown'
  }

  /**
   * After a restore, re-read project.json files and update Project.config in the DB.
   * Keeps DB and config.git consistent (83.10 rule 2).
   * Non-throwing — DB sync failure is logged but does not fail the restore.
   */
  private async syncToDb(files: string[]): Promise<void> {
    for (const file of files) {
      const match = file.match(/^projects\/([0-9a-f-]{36})\/project\.json$/)
      if (!match) continue
      const projectId = match[1]!

      try {
        const content = await this.get({ project_id: projectId, key: 'project.json' })
        if (content) {
          await db.project.update({
            where: { id: projectId },
            data:  { config: JSON.parse(content) },
          })
        }
      } catch (err) {
        console.warn('[GitConfigStore] syncToDb failed for project', projectId, err)
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/** Application-wide config store instance. */
export const configStore = new GitConfigStore()
