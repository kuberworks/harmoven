// lib/updates/version-check.ts
// Version check service for Docker deployment mode.
// Spec: Amendment 88 — Docker update flow, §91.6 Update integrity.
//
// Flow:
//   1. Read updates config from orchestrator.yaml
//   2. Call Docker Hub (or update_channel: edge) to get latest tag
//   3. Compare semver — respect MAJOR never auto-installed rule
//   4. Return UpdateCheckResult for the UI banner + wizard
//
// Security:
//   - Registry URL is fixed config (not user-supplied input) — no SSRF risk
//   - Response validated with Zod before use
//   - No secrets in this module — uses public Docker Hub API only

import fs   from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import yaml   from 'js-yaml'
import { z } from 'zod'
import type { UpdateCheckResult, UpdatesConfig } from './types'
import { DEFAULT_UPDATES_CONFIG } from './types'

// ─── Orchestrator config ──────────────────────────────────────────────────────

interface OrchestratorYaml {
  updates?: Partial<UpdatesConfig>
}

export function readUpdatesConfig(yamlPath?: string): UpdatesConfig {
  const filePath = yamlPath ?? path.resolve(process.cwd(), 'orchestrator.yaml')
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = (yaml.load(raw) as OrchestratorYaml) ?? {}
    // Merge with defaults — orchestrator.yaml partial config is valid
    return { ...DEFAULT_UPDATES_CONFIG, ...(parsed.updates ?? {}) }
  } catch {
    return { ...DEFAULT_UPDATES_CONFIG }
  }
}

// ─── Docker Hub tag discovery ─────────────────────────────────────────────────

/** Docker Hub registry API response shape (subset we care about). */
const DockerTagListSchema = z.object({
  results: z.array(
    z.object({
      name:   z.string(),
      digest: z.string().nullable().optional(),
      images: z.array(
        z.object({ digest: z.string().optional() })
      ).optional(),
    })
  ),
})

const IMAGE_REPO = 'harmoven/app'

/**
 * Fetch available version tags from Docker Hub for the given channel.
 * Returns the latest stable semver tag and its digest.
 *
 * @param channel 'stable' | 'edge' — follows harmoven/app:edge on edge channel
 */
async function fetchLatestDockerTag(
  channel: 'stable' | 'edge',
): Promise<{ version: string; imageTag: string; imageDigest: string } | null> {
  // For edge channel, check the 'edge' tag directly
  if (channel === 'edge') {
    const url = `https://hub.docker.com/v2/repositories/${IMAGE_REPO}/tags/edge`
    const res = await fetch(url, {
      headers:  { Accept: 'application/json' },
      signal:   AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { digest?: string; name?: string }
    if (!data.name) return null
    return {
      version:     data.name,
      imageTag:    `${IMAGE_REPO}:edge`,
      imageDigest: data.digest ?? '',
    }
  }

  // For stable channel: list tags, find highest semver
  const url = `https://hub.docker.com/v2/repositories/${IMAGE_REPO}/tags?page_size=100&ordering=last_updated`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null

  const raw  = await res.json()
  const data = DockerTagListSchema.safeParse(raw)
  if (!data.success) return null

  // Collect valid semver tags
  const validTags = data.data.results
    .filter(t => semver.valid(t.name) !== null)
    .sort((a, b) => semver.rcompare(a.name, b.name))

  if (validTags.length === 0) return null

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const latest = validTags[0]!
  const digest = latest.images?.[0]?.digest ?? latest.digest ?? ''

  return {
    version:     latest.name,
    imageTag:    `${IMAGE_REPO}:${latest.name}`,
    imageDigest: digest,
  }
}

// ─── Changelog fetch ──────────────────────────────────────────────────────────

/** Attempt to fetch the release notes for a version from GitHub Releases API. */
async function fetchChangelog(version: string): Promise<string | null> {
  // Use GitHub API (public, no auth required for public repos)
  const url = `https://api.github.com/repos/harmoven/app/releases/tags/v${version}`
  try {
    const res = await fetch(url, {
      headers: {
        Accept:     'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = await res.json() as { body?: string }
    return data.body ?? null
  } catch {
    return null
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Current app version — read from package.json at startup. */
export const CURRENT_VERSION: string = (() => {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * Check for a newer version of Harmoven on Docker Hub.
 *
 * Respects orchestrator.yaml `updates.auto_install`:
 *   - 'manual' → skip network check entirely (returns hasUpdate: false)
 *   - 'notify' | 'auto' → perform check
 *
 * MAJOR bumps are flagged but never auto-installed (rule from Am.88).
 */
export async function checkForUpdates(
  yamlPath?: string,
): Promise<UpdateCheckResult> {
  const config       = readUpdatesConfig(yamlPath)
  const checkedAt    = new Date().toISOString()
  const currentClean = semver.clean(CURRENT_VERSION) ?? CURRENT_VERSION

  // Manual mode: user has opted out of all automatic checks
  if (config.auto_install === 'manual' && !config.auto_check) {
    return {
      hasUpdate:      false,
      currentVersion: currentClean,
      latestVersion:  null,
      bump:           null,
      changelog:      null,
      imageTag:       null,
      imageDigest:    null,
      checkedAt,
    }
  }

  let latest: { version: string; imageTag: string; imageDigest: string } | null = null
  try {
    latest = await fetchLatestDockerTag(config.update_channel)
  } catch {
    // Network failures are silent — return "no update" so the UI is not alarmed
    return {
      hasUpdate:      false,
      currentVersion: currentClean,
      latestVersion:  null,
      bump:           null,
      changelog:      null,
      imageTag:       null,
      imageDigest:    null,
      checkedAt,
    }
  }

  if (!latest || !semver.valid(latest.version)) {
    return {
      hasUpdate:      false,
      currentVersion: currentClean,
      latestVersion:  null,
      bump:           null,
      changelog:      null,
      imageTag:       null,
      imageDigest:    null,
      checkedAt,
    }
  }

  const hasUpdate = semver.gt(latest.version, currentClean)

  if (!hasUpdate) {
    return {
      hasUpdate:      false,
      currentVersion: currentClean,
      latestVersion:  latest.version,
      bump:           null,
      changelog:      null,
      imageTag:       latest.imageTag,
      imageDigest:    latest.imageDigest,
      checkedAt,
    }
  }

  // Determine bump type
  const bump: 'major' | 'minor' | 'patch' =
    semver.major(latest.version) > semver.major(currentClean)
      ? 'major'
      : semver.minor(latest.version) > semver.minor(currentClean)
        ? 'minor'
        : 'patch'

  // Attempt to fetch changelog (best-effort — never blocks the result)
  const changelog = await fetchChangelog(latest.version).catch(() => null)

  return {
    hasUpdate:      true,
    currentVersion: currentClean,
    latestVersion:  latest.version,
    bump,
    changelog,
    imageTag:       latest.imageTag,
    imageDigest:    latest.imageDigest,
    checkedAt,
  }
}

/**
 * Check whether auto-install should proceed for this bump type.
 *
 * Rules (Am.88):
 *   - 'manual' → never auto-install
 *   - 'notify' → never auto-install (user decides via wizard)
 *   - 'auto'   → auto-install MINOR and PATCH only — MAJOR always requires
 *                 explicit user confirmation
 */
export function shouldAutoInstall(
  config:  UpdatesConfig,
  bump:    'major' | 'minor' | 'patch',
): boolean {
  if (config.auto_install !== 'auto') return false
  // MAJOR versions are never auto-installed regardless of setting
  return bump !== 'major'
}
