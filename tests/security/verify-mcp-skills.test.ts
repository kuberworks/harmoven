// tests/security/verify-mcp-skills.test.ts
// Unit tests for lib/bootstrap/verify-mcp-skills.ts
// Uses real file I/O in a tmp directory — no network.

import { mkdtemp, writeFile, rm }  from 'node:fs/promises'
import { createHash }               from 'node:crypto'
import { tmpdir }                   from 'node:os'
import path                         from 'node:path'
import { verifyMCPSkills }          from '@/lib/bootstrap/verify-mcp-skills'

// ─── Mock supply-chain-monitor (we only want to test the hash logic) ──────────

const mockReport = jest.fn()
jest.mock('@/lib/security/supply-chain-monitor', () => ({
  reportMCPSkillHashMismatch: (...args: unknown[]) => mockReport(...args),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function writeSkillFile(dir: string, name: string, content: string) {
  const p = path.join(dir, name)
  await writeFile(p, content, 'utf8')
  return p
}

function sha256hex(content: string) {
  return createHash('sha256').update(content).digest('hex')
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('verifyMCPSkills', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'mcp-test-'))
    mockReport.mockClear()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('passes for a valid skill with correct hash', async () => {
    const content = 'console.log("hello")'
    const ep = await writeSkillFile(tmpDir, 'skill.js', content)

    const results = await verifyMCPSkills([{
      name:       'my-skill',
      version:    '1.0.0',
      entrypoint: ep,
      sha256:     sha256hex(content),
    }])

    expect(results).toHaveLength(1)
    expect(results[0].passed).toBe(true)
    expect(mockReport).not.toHaveBeenCalled()
  })

  it('fails for a wrong hash and calls reportMCPSkillHashMismatch', async () => {
    const ep = await writeSkillFile(tmpDir, 'tampered.js', 'evil code')

    const results = await verifyMCPSkills([{
      name:       'tampered-skill',
      version:    '1.0.0',
      entrypoint: ep,
      sha256:     sha256hex('original code'),  // wrong hash
    }])

    expect(results[0].passed).toBe(false)
    expect(results[0].reason).toMatch(/mismatch/i)
    expect(mockReport).toHaveBeenCalledTimes(1)
    expect(mockReport.mock.calls[0][0].skillName).toBe('tampered-skill')
  })

  it('fails for invalid semver version', async () => {
    const ep = await writeSkillFile(tmpDir, 'ok.js', 'ok')
    const results = await verifyMCPSkills([{
      name:       'bad-version',
      version:    'not-semver',
      entrypoint: ep,
      sha256:     sha256hex('ok'),
    }])
    expect(results[0].passed).toBe(false)
    expect(results[0].reason).toMatch(/semver/i)
  })

  it('fails when entrypoint file is missing', async () => {
    const results = await verifyMCPSkills([{
      name:       'missing-skill',
      version:    '1.0.0',
      entrypoint: '/nonexistent/path/skill.js',
      sha256:     'a'.repeat(64),
    }])
    expect(results[0].passed).toBe(false)
    expect(results[0].reason).toMatch(/not found/i)
  })

  it('fails for malformed sha256 (not 64 hex chars)', async () => {
    const ep = await writeSkillFile(tmpDir, 'x.js', 'x')
    const results = await verifyMCPSkills([{
      name:       'bad-hash',
      version:    '1.0.0',
      entrypoint: ep,
      sha256:     'short',   // malformed
    }])
    expect(results[0].passed).toBe(false)
    expect(results[0].reason).toMatch(/malformed/i)
  })

  it('processes all skills and returns a result per skill', async () => {
    const c1 = 'skill one'
    const c2 = 'skill two'
    const ep1 = await writeSkillFile(tmpDir, 's1.js', c1)
    const ep2 = await writeSkillFile(tmpDir, 's2.js', c2)

    const results = await verifyMCPSkills([
      { name: 'skill-1', version: '1.0.0', entrypoint: ep1, sha256: sha256hex(c1) },
      { name: 'skill-2', version: '1.0.0', entrypoint: ep2, sha256: sha256hex(c2) },
    ])

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.passed)).toBe(true)
  })

  it('in strict mode, throws on first failure instead of continuing', async () => {
    const ep = await writeSkillFile(tmpDir, 'fail.js', 'original')
    await expect(
      verifyMCPSkills(
        [{ name: 'strict-fail', version: '1.0.0', entrypoint: ep, sha256: sha256hex('different') }],
        true, // strict
      )
    ).rejects.toThrow(/strict mode/)
  })

  it('returns empty array for empty skill list', async () => {
    const results = await verifyMCPSkills([])
    expect(results).toHaveLength(0)
  })
})
