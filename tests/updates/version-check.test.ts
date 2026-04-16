// tests/updates/version-check.test.ts
// Unit tests for lib/updates/version-check.ts
// Zero network dependency — all fetch calls mocked via jest.spyOn.

import semver from 'semver'
import {
  checkForUpdates,
  shouldAutoInstall,
  CURRENT_VERSION,
  readUpdatesConfig,
} from '@/lib/updates/version-check'
import { DEFAULT_UPDATES_CONFIG } from '@/lib/updates/types'
import type { UpdatesConfig } from '@/lib/updates/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Docker Hub tag list response for a given set of versions. */
function buildDockerHubTagResponse(versions: string[]) {
  return {
    results: versions.map(v => ({
      name:   v,
      digest: `sha256:${'a'.repeat(64)}`,
      images: [{ digest: `sha256:${'a'.repeat(64)}` }],
    })),
  }
}

// ─── readUpdatesConfig ────────────────────────────────────────────────────────

describe('readUpdatesConfig', () => {
  it('returns defaults when orchestrator.yaml is missing', () => {
    const config = readUpdatesConfig('/nonexistent/path/orchestrator.yaml')
    expect(config).toEqual(DEFAULT_UPDATES_CONFIG)
  })
})

// ─── shouldAutoInstall ────────────────────────────────────────────────────────

describe('shouldAutoInstall', () => {
  const autoConfig: UpdatesConfig = { ...DEFAULT_UPDATES_CONFIG, auto_install: 'auto' }
  const notifyConfig: UpdatesConfig = { ...DEFAULT_UPDATES_CONFIG, auto_install: 'notify' }
  const manualConfig: UpdatesConfig = { ...DEFAULT_UPDATES_CONFIG, auto_install: 'manual' }

  it.each([
    { config: autoConfig,   bump: 'patch'  as const, expected: true  },
    { config: autoConfig,   bump: 'minor'  as const, expected: true  },
    { config: autoConfig,   bump: 'major'  as const, expected: false }, // MAJOR never auto
    { config: notifyConfig, bump: 'patch'  as const, expected: false },
    { config: notifyConfig, bump: 'minor'  as const, expected: false },
    { config: notifyConfig, bump: 'major'  as const, expected: false },
    { config: manualConfig, bump: 'patch'  as const, expected: false },
  ])('auto_install=$config.auto_install + bump=$bump → $expected', ({ config, bump, expected }) => {
    expect(shouldAutoInstall(config, bump)).toBe(expected)
  })
})

// ─── checkForUpdates ─────────────────────────────────────────────────────────

describe('checkForUpdates', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  function mockFetch(responses: Array<{ ok: boolean; json: unknown }>) {
    let callCount = 0
    global.fetch = jest.fn(async () => {
      const resp = responses[callCount] ?? responses[responses.length - 1]
      callCount++
      return {
        ok:   resp!.ok,
        json: async () => resp!.json,
      } as Response
    })
  }

  it('returns hasUpdate: true when newer version exists (minor bump)', async () => {
    const latestVersion = (() => {
      const [major, minor, patch] = CURRENT_VERSION.split('.').map(Number) as [number, number, number]
      return `${major}.${minor + 1}.${patch}`
    })()

    mockFetch([
      // First call: Docker Hub tag list
      { ok: true, json: buildDockerHubTagResponse([latestVersion, CURRENT_VERSION]) },
      // Second call: GitHub changelog (optional)
      { ok: false, json: {} },
    ])

    const result = await checkForUpdates('/dev/null')  // forces default config

    expect(result.hasUpdate).toBe(true)
    expect(result.latestVersion).toBe(latestVersion)
    expect(result.currentVersion).toBe(semver.clean(CURRENT_VERSION))
    expect(result.bump).toBe('minor')
  })

  it('returns hasUpdate: true for patch bump', async () => {
    const [major, minor, patch] = CURRENT_VERSION.split('.').map(Number) as [number, number, number]
    const latestVersion = `${major}.${minor}.${patch + 1}`

    mockFetch([
      { ok: true, json: buildDockerHubTagResponse([latestVersion]) },
      { ok: false, json: {} },
    ])

    const result = await checkForUpdates('/dev/null')

    expect(result.hasUpdate).toBe(true)
    expect(result.bump).toBe('patch')
  })

  it('returns hasUpdate: true for major bump', async () => {
    const [major] = CURRENT_VERSION.split('.').map(Number) as [number, number, number]
    const latestVersion = `${major + 1}.0.0`

    mockFetch([
      { ok: true, json: buildDockerHubTagResponse([latestVersion]) },
      { ok: false, json: {} },
    ])

    const result = await checkForUpdates('/dev/null')

    expect(result.hasUpdate).toBe(true)
    expect(result.bump).toBe('major')
  })

  it('returns hasUpdate: false when already on latest version', async () => {
    mockFetch([
      { ok: true, json: buildDockerHubTagResponse([CURRENT_VERSION]) },
    ])

    const result = await checkForUpdates('/dev/null')

    expect(result.hasUpdate).toBe(false)
    expect(result.bump).toBeNull()
  })

  it('returns hasUpdate: false when Docker Hub returns no valid semver tags', async () => {
    mockFetch([
      { ok: true, json: { results: [{ name: 'latest', digest: '' }] } },
    ])

    const result = await checkForUpdates('/dev/null')

    expect(result.hasUpdate).toBe(false)
    expect(result.latestVersion).toBeNull()
  })

  it('returns hasUpdate: false and does not throw on network failure', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED') }) as typeof fetch

    const result = await checkForUpdates('/dev/null')

    expect(result.hasUpdate).toBe(false)
    expect(result.latestVersion).toBeNull()
  })

  it('includes changelog when GitHub release has body text', async () => {
    const [major, minor, patch] = CURRENT_VERSION.split('.').map(Number) as [number, number, number]
    const latestVersion = `${major}.${minor}.${patch + 1}`

    mockFetch([
      { ok: true, json: buildDockerHubTagResponse([latestVersion]) },
      { ok: true, json: { body: '## What is new\n- Fixed a bug' } },
    ])

    const result = await checkForUpdates('/dev/null')

    expect(result.hasUpdate).toBe(true)
    expect(result.changelog).toContain('Fixed a bug')
  })

  it('returns correct checkedAt ISO timestamp', async () => {
    mockFetch([
      { ok: false, json: {} },
    ])

    const before = Date.now()
    const result = await checkForUpdates('/dev/null')
    const after  = Date.now()

    const ts = new Date(result.checkedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})
