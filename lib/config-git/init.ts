// lib/config-git/init.ts
// initConfigRepo — initialize the config.git repository on startup.
// Amendment 83 (Section 83.4) + security fix Am.94.4.
//
// Idempotent: safe to call on every startup.
// If the repo already exists, this is a no-op.
//
// SECURITY (Am.94.4):
//   - All git commands use execFileAsync — no shell interpolation.
//   - assertSafePath validates the root before any operation.
//   - .gitignore written to exclude secrets and runtime files.

import { existsSync }  from 'fs'
import { promises as fs } from 'fs'
import path             from 'path'

import { execFileAsync, assertSafePath } from '@/lib/utils/exec-safe'
import { getConfigGitRoot }              from './paths'

// ─── .gitignore content ───────────────────────────────────────────────────────

// Credentials and runtime state must NEVER be versioned (83.12).
const GITIGNORE_CONTENT = `# config.git/.gitignore
# Managed by Harmoven — do not edit manually.

# Secrets — always excluded regardless of where they land
*.key
*.pem
*.env
credentials.json

# DB files (runtime state)
*.db
*.db-journal
*.db-wal

# Temp files
*.tmp
.DS_Store
`

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Initialize the config.git repository.
 * Creates the repo if it doesn't exist, writes .gitignore, and makes
 * an initial commit if needed.
 *
 * Safe to call on every startup — checks for existing .git directory first.
 */
export async function initConfigRepo(): Promise<void> {
  const root = getConfigGitRoot()
  assertSafePath(root)

  const gitDir = path.join(root, '.git')

  if (existsSync(gitDir)) {
    // Already initialized — nothing to do
    return
  }

  // Create the directory if missing
  await fs.mkdir(root, { recursive: true })

  // Initialize bare repo
  await execFileAsync('git', ['init', root])

  // Identity (required for commits; Am.94.4 passes via env in execFileAsync)
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Harmoven'])
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'config@harmoven.local'])
  await execFileAsync('git', ['-C', root, 'config', 'core.autocrlf', 'false'])

  // Write .gitignore (83.12)
  const gitignorePath = path.join(root, '.gitignore')
  await fs.writeFile(gitignorePath, GITIGNORE_CONTENT, 'utf8')

  // Initial commit
  await execFileAsync('git', ['-C', root, 'add', '.gitignore'])
  await execFileAsync('git', ['-C', root, 'commit', '-m', 'init: config.git initialized by Harmoven'])
}
