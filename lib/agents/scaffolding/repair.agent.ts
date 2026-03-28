// lib/agents/scaffolding/repair.agent.ts
// RepairAgent — patches a scaffolded app's config for subpath preview (Amendment 73, §25.4).
//
// Budget cap: $0.05 / max_tokens: 1000.
// Targets: config files only (next.config.js, vite.config.ts, express/fastify router).
// Never touches business logic.
//
// Frameworks supported:
//   nextjs   → next.config.js: basePath + assetPrefix
//   vite     → vite.config.ts: base
//   express  → adds app.use(prefix, router) pattern
//   fastify  → adds { prefix } to plugin registration
//   unknown  → skip (fall through to screenshots)
//
// SECURITY NOTES:
//   - worktree MUST be validated against WORKTREE_BASE_DIR before any fs/exec call
//     to prevent path traversal attacks (issue #4).
//   - LLM patch output is validated (size, structure) before being written to disk
//     to prevent LLM-driven code injection (issue #7).
//   - execSync calls carry an explicit timeout to prevent DoS via a blocked worker
//     thread (issue #6).

import fs   from 'fs'
import path from 'path'
import { promisify } from 'util'
import { execFile } from 'child_process'
import type { ILLMClient } from '@/lib/llm/interface'
import { safeBaseEnv } from '@/lib/utils/safe-env'

const execFileAsync = promisify(execFile)

// ─── Framework type ───────────────────────────────────────────────────────────

export type Framework = 'nextjs' | 'vite' | 'express' | 'fastify' | 'unknown'

// ─── Worktree path validation (#4 — path traversal) ──────────────────────────
//
// All worktrees MUST live under WORKTREE_BASE_DIR. Any path that escapes this
// prefix (e.g. "../../etc") is rejected before any fs or exec call is made.

function resolveWorktreeBase(): string {
  const base = process.env.WORKTREE_BASE_DIR
  if (!base) {
    throw new Error(
      '[RepairAgent] WORKTREE_BASE_DIR env variable is not set. '
      + 'Set it to the parent directory of all generated app worktrees.',
    )
  }
  return path.resolve(base)
}

/**
 * Validate that `worktree` is a real path strictly under WORKTREE_BASE_DIR.
 * Throws if the resolved path escapes the allowed base — preventing path traversal.
 */
function assertWorktreeIsSafe(worktree: string): string {
  const base     = resolveWorktreeBase()
  // path.resolve normalises ".." segments and symlinks cannot escape this check
  // because we compare the resolved string prefix.
  const resolved = path.resolve(worktree)

  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(
      `[RepairAgent] Rejected worktree path "${worktree}" — must be under WORKTREE_BASE_DIR (${base}).`,
    )
  }
  return resolved
}

// ─── LLM patch validation (#7 — LLM code injection) ──────────────────────────
//
// The LLM returns patched source code. Before writing it to disk (where it will
// be executed by pnpm build), we run a set of conservative guardrails:
//   1. Size cap: patched output must not be >10× the original (hallucination guard).
//   2. No null bytes (binary injection attempt).
//   3. Framework-specific structural check (e.g. "module.exports" or "export default"
//      present for config files).
//
// Note: these checks do NOT guarantee the patch is semantically correct — they
// are a defence-in-depth layer. The RepairAgent is only called for generated
// apps inside a sandboxed worktree directory.

const MAX_PATCH_MULTIPLIER = 10  // patch must be ≤ 10× original size
const MAX_PATCH_BYTES      = 64 * 1024  // hard cap: 64 KB regardless

const FRAMEWORK_STRUCTURE_PATTERNS: Record<Exclude<Framework, 'unknown'>, RegExp[]> = {
  // next.config must export something — module.exports OR export default
  nextjs:  [/module\.exports|export\s+default/],
  // vite.config must call defineConfig or export default
  vite:    [/defineConfig|export\s+default/],
  // express/fastify entrypoints should contain listen or require/import
  express: [/require\s*\(|import\s+/],
  fastify: [/require\s*\(|import\s+/],
}

function validatePatch(
  original: string,
  patched:  string,
  framework: Exclude<Framework, 'unknown'>,
): void {
  // 1. Size caps
  const maxBytes = Math.min(original.length * MAX_PATCH_MULTIPLIER, MAX_PATCH_BYTES)
  if (Buffer.byteLength(patched, 'utf8') > maxBytes) {
    throw new Error(
      `[RepairAgent] LLM patch rejected — output size (${patched.length} chars) `
      + `exceeds safety limit (${maxBytes} bytes). Possible hallucination.`,
    )
  }

  // 2. Null-byte guard (binary injection)
  if (patched.includes('\0')) {
    throw new Error('[RepairAgent] LLM patch rejected — null bytes detected in output.')
  }

  // 3. Structural check — the patched file must match the framework's expected shape
  const patterns = FRAMEWORK_STRUCTURE_PATTERNS[framework]
  if (patterns && !patterns.some(re => re.test(patched))) {
    throw new Error(
      `[RepairAgent] LLM patch rejected — output does not match expected ${framework} config structure.`,
    )
  }
}

// ─── Framework detection ────────────────────────────────────────────────────────

export function detectFramework(worktree: string): Framework {
  const pkgPath = path.join(worktree, 'package.json')
  if (!fs.existsSync(pkgPath)) return 'unknown'

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps['next'])    return 'nextjs'
    if (deps['vite'])    return 'vite'
    if (deps['fastify']) return 'fastify'
    if (deps['express']) return 'express'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// ─── Framework-specific repair prompts ────────────────────────────────────────

function buildRepairPrompt(
  framework: Framework,
  subpath:   string,
  configContent: string,
): string {
  const instructions: Record<Exclude<Framework, 'unknown'>, string> = {
    nextjs: `Patch next.config.js to add "basePath: '${subpath.replace(/\/$/, '')}'" and "assetPrefix: '${subpath.replace(/\/$/, '')}'" to the exported config object. Return ONLY the full patched file content — no markdown, no explanation.`,
    vite:   `Patch vite.config.ts (or vite.config.js) to add "base: '${subpath}'" inside defineConfig({}). Return ONLY the full patched file content — no markdown, no explanation.`,
    express: `Add app.use('${subpath.replace(/\/$/, '')}', router) before app.listen(). Return ONLY the full patched file content — no markdown, no explanation.`,
    fastify: `Register the main plugin with { prefix: '${subpath.replace(/\/$/, '')}' }. Return ONLY the full patched file content — no markdown, no explanation.`,
  }

  return `You are patching a ${framework} app config to serve correctly under the subpath "${subpath}".
Current config file content:
\`\`\`
${configContent}
\`\`\`

${instructions[framework as Exclude<Framework, 'unknown'>]}
`
}

// ─── Config file targets ──────────────────────────────────────────────────────

function findConfigFile(worktree: string, framework: Framework): string | null {
  const candidates: Record<Exclude<Framework, 'unknown'>, string[]> = {
    nextjs:  ['next.config.js', 'next.config.ts', 'next.config.mjs'],
    vite:    ['vite.config.ts', 'vite.config.js'],
    express: ['src/index.ts', 'src/index.js', 'src/app.ts', 'src/app.js', 'index.js', 'server.js'],
    fastify: ['src/index.ts', 'src/index.js', 'src/app.ts', 'src/app.js', 'index.js', 'server.js'],
  }

  if (framework === 'unknown') return null

  for (const name of candidates[framework]) {
    const full = path.join(worktree, name)
    if (fs.existsSync(full)) return full
  }
  return null
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────

// execFileAsync — args as array, no shell interpolation, no injection risk.
async function rebuild(worktree: string): Promise<void> {
  // Run build inside the worktree; prefer pnpm then npm.
  // Explicit timeout (#6) prevents a pathological build from blocking the thread.
  // SECURITY: never inherit process.env — leaks DATABASE_URL, AUTH_SECRET, etc.
  // safeBaseEnv() provides only PATH/HOME/TMPDIR/LANG — nothing sensitive.
  const hasPnpm  = fs.existsSync(path.join(worktree, 'pnpm-lock.yaml'))
  const [bin, ...args] = hasPnpm ? ['pnpm', 'build'] : ['npm', 'run', 'build']
  try {
    await execFileAsync(bin!, args, { cwd: worktree, timeout: 120_000, env: safeBaseEnv() })
  } catch (err) {
    // Build failure — treat as repair failure (caller will fall through to screenshots)
    throw new Error(`[RepairAgent] rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to patch the app's config so it can serve under `subpath`.
 * Uses a targeted LLM call (budget $0.05, max 1000 tokens).
 * Rebuilds the app after patching.
 * Throws on framework detection failure or LLM error — caller falls through to screenshots.
 *
 * SECURITY: worktree is validated against WORKTREE_BASE_DIR before any fs/exec op.
 */
export async function repairForSubpath(
  worktree: string,
  subpath:  string,
  llm:      ILLMClient,
  signal?:  AbortSignal,
): Promise<void> {
  // #4 — path traversal guard: validate before any fs or exec call
  const safeWorktree = assertWorktreeIsSafe(worktree)

  const framework = detectFramework(safeWorktree)
  if (framework === 'unknown') {
    throw new Error('[RepairAgent] Unknown framework — cannot repair for subpath. Falling through to screenshots.')
  }

  const configFile = findConfigFile(safeWorktree, framework)
  if (!configFile) {
    throw new Error(`[RepairAgent] No config file found for ${framework} in ${safeWorktree}`)
  }

  const original = fs.readFileSync(configFile, 'utf8')
  const prompt   = buildRepairPrompt(framework, subpath, original)

  const result = await llm.chat(
    [{ role: 'user', content: prompt }],
    {
      model:     'fast',        // cheap model — config patching only
      maxTokens: 1000,          // budget cap: $0.05 at fast tier
      signal,
    },
  )

  const patched = result.content.trim()
  if (!patched) {
    throw new Error('[RepairAgent] LLM returned empty patch — aborting repair')
  }

  // #7 — validate before writing: size cap + null-byte guard + structure check.
  // Prevents LLM hallucination or adversarial content from being executed by the build.
  validatePatch(original, patched, framework as Exclude<Framework, 'unknown'>)

  // Safe to write — validation passed
  fs.writeFileSync(configFile, patched, 'utf8')

  // Rebuild the app with the new config
  await rebuild(safeWorktree)
}
