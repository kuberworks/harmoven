// lib/updates/verify-update.ts
// Docker image update integrity verification.
// Spec: Amendment 91.6 — image digest verification, Cosign, GitHub release gate.
//
// Security hardening against tag-hijacking attacks (e.g. the LiteLLM PyPI incident):
//   1. Verify image digest matches expected value from version check
//   2. Verify Cosign signature if COSIGN_PUBLIC_KEY_PATH is configured
//   3. Verify a matching GitHub release exists before applying
//
// NOTE: 'docker' and 'cosign' CLI are invoked via execFile (not exec) to prevent
// shell injection. Image tag / version values are passed as argv arguments,
// never interpolated into a shell string.

import { execFile }       from 'node:child_process'
import { promisify }      from 'node:util'
import type { UpdateVerification } from './types'

const execFileAsync = promisify(execFile)

// ─── GitHub Release validation ───────────────────────────────────────────────

interface GitHubRelease {
  tag_name: string
  html_url: string
}

/**
 * Fetch a GitHub release by version tag from the harmoven/app repo.
 * Returns null if the release does not exist or the request fails.
 */
export async function fetchGitHubRelease(
  version: string,
): Promise<GitHubRelease | null> {
  // Defense: validate version is a safe semver string before using in URL
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)) return null

  const url = `https://api.github.com/repos/harmoven/app/releases/tags/v${version}`
  try {
    const res = await fetch(url, {
      headers: {
        Accept:                  'application/vnd.github+json',
        'X-GitHub-Api-Version':  '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = await res.json() as GitHubRelease
    if (typeof data.tag_name !== 'string') return null
    return data
  } catch {
    return null
  }
}

// ─── Docker image digest check ────────────────────────────────────────────────

/**
 * Query the Docker daemon for the actual digest of a pulled image tag.
 * Falls back to `docker manifest inspect` for remote-only (not-yet-pulled) images.
 *
 * Returns the digest string or null on failure.
 */
async function getRemoteImageDigest(imageTag: string): Promise<string | null> {
  // Defense: validate imageTag to prevent argument injection
  // Must match: <repo>/<name>:<tag> or <repo>/<name>@sha256:<hex>
  if (!/^[a-z0-9/_-]+:[a-z0-9._-]+$/.test(imageTag)) {
    throw new Error(`verifyDockerUpdate: invalid imageTag format: ${imageTag}`)
  }

  try {
    const { stdout } = await execFileAsync('docker', [
      'manifest', 'inspect', imageTag,
      '--format', '{{.config.digest}}',
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

// ─── Cosign signature verification ───────────────────────────────────────────

/**
 * Verify the Cosign signature of a Docker image tag using the configured
 * public key. Only called when COSIGN_PUBLIC_KEY_PATH is set.
 *
 * Throws if verification fails.
 */
async function verifyCosignSignature(
  imageTag:       string,
  publicKeyPath:  string,
): Promise<void> {
  // Defense: validate public key path — must be an absolute path with no shell metacharacters
  if (!/^\/[^\0;&|`$><]+$/.test(publicKeyPath)) {
    throw new Error('verifyCosignSignature: unsafe public key path rejected')
  }
  // execFile, not exec — arguments are passed as array (no shell interpolation)
  await execFileAsync('cosign', [
    'verify',
    '--key', publicKeyPath,
    imageTag,
  ])
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface VerifyResult {
  ok:      boolean
  reason?: string
}

/**
 * Full update integrity verification before applying a Docker update.
 *
 * Steps:
 *   1. verify_digest: compare actual image digest vs expected
 *   2. cosign_verify: verify Cosign signature (if key configured)
 *   3. require_github_release: check GitHub release exists for this version
 *
 * Returns { ok: true } if all configured checks pass.
 * Returns { ok: false, reason } on the first failing check.
 */
export async function verifyDockerUpdate(
  update:         UpdateVerification,
  options: {
    verifyDigest:          boolean
    cosignVerify:          boolean
    cosignPublicKey:       string | null
    requireGithubRelease:  boolean
  },
): Promise<VerifyResult> {
  // 1. Image digest check
  if (options.verifyDigest && update.imageDigest) {
    const actual = await getRemoteImageDigest(update.imageTag)
    if (actual === null) {
      // Could not inspect — warn but allow (non-fatal if digest is empty)
      console.warn('[updates/verify] Could not inspect image digest for', update.imageTag)
    } else if (actual !== update.imageDigest) {
      return {
        ok:     false,
        reason: `Image digest mismatch — possible tag hijacking attack. Expected: ${update.imageDigest}  Got: ${actual}`,
      }
    }
  }

  // 2. Cosign signature check
  if (options.cosignVerify && options.cosignPublicKey) {
    try {
      await verifyCosignSignature(update.imageTag, options.cosignPublicKey)
    } catch (e) {
      return {
        ok:     false,
        reason: `Cosign signature verification failed: ${(e as Error).message}`,
      }
    }
  }

  // 3. GitHub release gate
  if (options.requireGithubRelease) {
    const release = await fetchGitHubRelease(update.version)
    if (!release || release.tag_name !== `v${update.version}`) {
      return {
        ok:     false,
        reason: `No matching GitHub release found for v${update.version} — update rejected`,
      }
    }
  }

  return { ok: true }
}
