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

import fs   from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import type { ILLMClient } from '@/lib/llm/interface'

// ─── Framework detection ────────────────────────────────────────────────────────

export type Framework = 'nextjs' | 'vite' | 'express' | 'fastify' | 'unknown'

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

function rebuild(worktree: string): void {
  try {
    // Run build inside the worktree; prefer pnpm then npm
    const hasPnpm = fs.existsSync(path.join(worktree, 'pnpm-lock.yaml'))
    const cmd     = hasPnpm ? 'pnpm build' : 'npm run build'
    execSync(cmd, { cwd: worktree, stdio: 'pipe', timeout: 120_000 })
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
 */
export async function repairForSubpath(
  worktree: string,
  subpath:  string,
  llm:      ILLMClient,
  signal?:  AbortSignal,
): Promise<void> {
  const framework = detectFramework(worktree)
  if (framework === 'unknown') {
    throw new Error('[RepairAgent] Unknown framework — cannot repair for subpath. Falling through to screenshots.')
  }

  const configFile = findConfigFile(worktree, framework)
  if (!configFile) {
    throw new Error(`[RepairAgent] No config file found for ${framework} in ${worktree}`)
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

  // Write the patched config file
  fs.writeFileSync(configFile, patched, 'utf8')

  // Rebuild the app with the new config
  rebuild(worktree)
}
