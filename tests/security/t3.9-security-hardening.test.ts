// tests/security/t3.9-security-hardening.test.ts
// T3.9 — Security Hardening (Amendment 92 / 93) unit tests.
// All tests are zero-network / zero-DB via mocks.

// ─── Mocks declared before imports ───────────────────────────────────────────

// Mock dns/promises so assertNotPrivateHost never makes real network calls
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}))

// Mock the DB client so CredentialVault never hits a real database
jest.mock('@/lib/db/client', () => ({
  db: {
    projectCredential: {
      findFirst: jest.fn(),
    },
  },
}))

// Mock exec-safe so scanWorktreeForSecrets never spawns gitleaks
jest.mock('@/lib/utils/exec-safe', () => ({
  execFileAsync: jest.fn(),
  assertSafePath: jest.requireActual('@/lib/utils/exec-safe').assertSafePath,
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import * as dns from 'node:dns/promises'
import {
  ValidationError,
  assertSafeRef,
  assertSafeBranchName,
  assertSafeUrl,
  assertSafePath,
  assertUUID,
  isSafeRef,
  isSafeBranchName,
  isUUID,
} from '@/lib/utils/input-validation'

import {
  assertNotPrivateHost,
} from '@/lib/security/ssrf-protection'

import {
  safeBaseEnv,
  gitEnv,
} from '@/lib/utils/safe-env'

import {
  credentialVault,
} from '@/lib/execution/credential-scope'

import {
  scanWorktreeForSecrets,
} from '@/lib/agents/scaffolding/secret-scanner'

import { execFileAsync } from '@/lib/utils/exec-safe'
import { db } from '@/lib/db/client'

// ─── Typed mocks ─────────────────────────────────────────────────────────────

const mockLookup   = dns.lookup as jest.MockedFunction<typeof dns.lookup>
const mockExecFile = execFileAsync as jest.MockedFunction<typeof execFileAsync>
const mockFindFirst = (db.projectCredential.findFirst as jest.Mock)

// ─────────────────────────────────────────────────────────────────────────────
// 1. input-validation.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('input-validation / assertSafeRef', () => {
  it('accepts plain branch names', () => {
    expect(() => assertSafeRef('main')).not.toThrow()
    expect(() => assertSafeRef('feat/t3-9-security')).not.toThrow()
    expect(() => assertSafeRef('v1.2.3')).not.toThrow()
    expect(() => assertSafeRef('a1b2c3d4')).not.toThrow()
  })

  it('rejects shell injection characters', () => {
    const bad = [';rm -rf /', '$(evil)', '`id`', 'foo|bar', 'x&&y', 'a b']
    for (const ref of bad) {
      expect(() => assertSafeRef(ref)).toThrow(ValidationError)
    }
  })

  it('rejects empty string', () => {
    expect(() => assertSafeRef('')).toThrow(ValidationError)
  })

  it('rejects over-long refs', () => {
    expect(() => assertSafeRef('a'.repeat(257))).toThrow(ValidationError)
  })

  it('isSafeRef returns boolean', () => {
    expect(isSafeRef('main')).toBe(true)
    expect(isSafeRef('; DROP TABLE')).toBe(false)
  })
})

describe('input-validation / assertSafeBranchName', () => {
  it('accepts valid branch names', () => {
    expect(() => assertSafeBranchName('main')).not.toThrow()
    expect(() => assertSafeBranchName('feat/my-feature')).not.toThrow()
  })

  it('rejects .lock suffix (git reserved)', () => {
    expect(() => assertSafeBranchName('ref.lock')).toThrow(ValidationError)
  })

  it('rejects branches starting with special chars', () => {
    expect(() => assertSafeBranchName('.hidden')).toThrow(ValidationError)
    expect(() => assertSafeBranchName('-dash')).toThrow(ValidationError)
  })

  it('isSafeBranchName returns boolean', () => {
    expect(isSafeBranchName('main')).toBe(true)
    expect(isSafeBranchName('ref.lock')).toBe(false)
  })
})

describe('input-validation / assertSafeUrl', () => {
  it('accepts https and git URLs', () => {
    expect(() => assertSafeUrl('https://github.com/org/repo.git')).not.toThrow()
    expect(() => assertSafeUrl('git@github.com:org/repo.git')).not.toThrow()
    expect(() => assertSafeUrl('ssh://git@host/repo')).not.toThrow()
  })

  it('rejects file:// protocol', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(ValidationError)
  })

  it('rejects credentials embedded in http URL', () => {
    expect(() => assertSafeUrl('https://user:pass@github.com/repo')).toThrow(ValidationError)
  })

  it('rejects data: and javascript: URLs', () => {
    expect(() => assertSafeUrl('data:text/html,<h1>XSS</h1>')).toThrow(ValidationError)
    expect(() => assertSafeUrl('javascript:alert(1)')).toThrow(ValidationError)
  })
})

describe('input-validation / assertSafePath', () => {
  it('accepts normal paths', () => {
    expect(() => assertSafePath('/tmp/worktree-abc')).not.toThrow()
    expect(() => assertSafePath('/home/user/project')).not.toThrow()
  })

  it('rejects path traversal (..)', () => {
    expect(() => assertSafePath('/tmp/../etc/passwd')).toThrow(ValidationError)
    expect(() => assertSafePath('../../secret')).toThrow(ValidationError)
  })

  it('rejects null byte injection', () => {
    expect(() => assertSafePath('/tmp/file\0evil')).toThrow(ValidationError)
  })

  it('rejects empty string', () => {
    expect(() => assertSafePath('')).toThrow(ValidationError)
  })
})

describe('input-validation / assertUUID', () => {
  const VALID = '550e8400-e29b-41d4-a716-446655440000'

  it('accepts valid UUID v4', () => {
    expect(() => assertUUID(VALID)).not.toThrow()
    expect(() => assertUUID('00000000-0000-0000-0000-000000000000')).not.toThrow()
  })

  it('rejects non-UUID strings', () => {
    expect(() => assertUUID('not-a-uuid')).toThrow(ValidationError)
    expect(() => assertUUID('550e8400e29b41d4a716446655440000')).toThrow(ValidationError) // no hyphens
    expect(() => assertUUID('')).toThrow(ValidationError)
    expect(() => assertUUID(VALID + '-extra')).toThrow(ValidationError)
  })

  it('isUUID returns boolean', () => {
    expect(isUUID(VALID)).toBe(true)
    expect(isUUID('garbage')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. ssrf-protection.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('ssrf-protection / assertNotPrivateHost', () => {
  beforeEach(() => mockLookup.mockReset())

  it('allows public IPs', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as any)
    await expect(assertNotPrivateHost('https://api.example.com/v1')).resolves.toBeUndefined()
  })

  it('blocks RFC1918 10.x.x.x', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as any)
    await expect(assertNotPrivateHost('https://internal.corp/v1')).rejects.toThrow(ValidationError)
  })

  it('blocks RFC1918 192.168.x.x', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }] as any)
    await expect(assertNotPrivateHost('http://router.local/')).rejects.toThrow(ValidationError)
  })

  it('blocks loopback 127.0.0.1', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as any)
    await expect(assertNotPrivateHost('http://localhost:11434/')).rejects.toThrow(ValidationError)
  })

  it('blocks link-local 169.254.x.x (AWS metadata)', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as any)
    await expect(assertNotPrivateHost('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(ValidationError)
  })

  it('blocks IPv6 loopback ::1', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '::1', family: 6 }] as any)
    await expect(assertNotPrivateHost('http://[::1]:3000/')).rejects.toThrow(ValidationError)
  })

  it('blocks file:// protocol without DNS lookup', async () => {
    await expect(assertNotPrivateHost('file:///etc/passwd')).rejects.toThrow(ValidationError)
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('blocks URLs with embedded credentials', async () => {
    await expect(assertNotPrivateHost('https://user:pass@api.example.com/')).rejects.toThrow(ValidationError)
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('blocks when DNS resolution fails (fail-closed: SSRF protection)', async () => {
    // Spec: fail-closed — if DNS resolution fails for any reason, block the request.
    // An attacker controlling DNS could suppress resolution during validation
    // and then redirect to a private IP at call time.
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND custom-llm-host'))
    await expect(assertNotPrivateHost('https://custom-llm-host.private/v1')).rejects.toThrow(ValidationError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. safe-env.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('safe-env / safeBaseEnv', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL:   'postgres://user:secret@localhost/db',
      AUTH_SECRET:    'supersecret',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      HOME:           '/home/user',
      PATH:           '/usr/bin:/bin',
    }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('includes safe env vars (HOME, PATH)', () => {
    const env = safeBaseEnv()
    expect(env['PATH']).toBeDefined()
    expect(env['HOME']).toBeDefined()
  })

  it('strips sensitive secrets', () => {
    const env = safeBaseEnv()
    expect(env['DATABASE_URL']).toBeUndefined()
    expect(env['AUTH_SECRET']).toBeUndefined()
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
  })
})

describe('safe-env / gitEnv', () => {
  it('includes GIT_TERMINAL_PROMPT=0 (disables interactive prompts)', () => {
    const env = gitEnv()
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
  })

  it('accepts extras and merges them', () => {
    const env = gitEnv({ MY_EXTRA: 'value' })
    expect(env['MY_EXTRA']).toBe('value')
  })

  it('never exposes DATABASE_URL in git env', () => {
    process.env['DATABASE_URL'] = 'postgres://secret'
    const env = gitEnv()
    expect(env['DATABASE_URL']).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. credential-scope.ts / CredentialVault
// ─────────────────────────────────────────────────────────────────────────────

describe('CredentialVault', () => {
  const RUN_ID    = '11111111-1111-1111-1111-111111111111'
  const PROJ_ID   = '22222222-2222-2222-2222-222222222222'
  const API_KEY   = 'test-api-key-value'

  beforeEach(() => {
    mockFindFirst.mockReset()
    // Clean up any leftover scopes
    credentialVault.revokeRunScope(RUN_ID)
    process.env['ANTHROPIC_API_KEY'] = undefined as any
  })

  it('issues a scope and retrieves a token from process.env (dev fallback)', async () => {
    mockFindFirst.mockResolvedValue(null) // no DB record
    process.env['ANTHROPIC_API_KEY'] = API_KEY

    const scope = await credentialVault.issueRunScope(RUN_ID, PROJ_ID, ['anthropic'], 60)
    expect(scope.run_id).toBe(RUN_ID)
    expect(scope.providers).toContain('anthropic')

    const token = credentialVault.getTokenForRun(RUN_ID, 'anthropic')
    expect(token).toBe(API_KEY)
  })

  it('throws for unknown provider not in scope', async () => {
    mockFindFirst.mockResolvedValue(null)
    await credentialVault.issueRunScope(RUN_ID, PROJ_ID, ['anthropic'], 60)

    expect(() => credentialVault.getTokenForRun(RUN_ID, 'openai'))
      .toThrow(/not in scope/)
  })

  it('revokeRunScope removes the scope immediately', async () => {
    mockFindFirst.mockResolvedValue(null)
    process.env['ANTHROPIC_API_KEY'] = API_KEY

    await credentialVault.issueRunScope(RUN_ID, PROJ_ID, ['anthropic'], 60)
    credentialVault.revokeRunScope(RUN_ID)

    expect(() => credentialVault.getTokenForRun(RUN_ID, 'anthropic'))
      .toThrow(/No credential scope/)
  })

  it('throws when scope is expired', async () => {
    mockFindFirst.mockResolvedValue(null)
    process.env['ANTHROPIC_API_KEY'] = API_KEY

    // Issue scope with -1 minute TTL (already expired)
    await credentialVault.issueRunScope(RUN_ID, PROJ_ID, ['anthropic'], -1)

    expect(() => credentialVault.getTokenForRun(RUN_ID, 'anthropic'))
      .toThrow(/expired/)
  })

  it('gcExpired removes expired scopes and returns count', async () => {
    mockFindFirst.mockResolvedValue(null)
    process.env['ANTHROPIC_API_KEY'] = API_KEY

    await credentialVault.issueRunScope(RUN_ID, PROJ_ID, ['anthropic'], -1) // expired
    const removed = credentialVault.gcExpired()
    expect(removed).toBeGreaterThanOrEqual(1)
    // After GC, scope is gone
    expect(() => credentialVault.getTokenForRun(RUN_ID, 'anthropic'))
      .toThrow(/No credential scope/)
  })

  it('throws when no scope exists for runId', () => {
    expect(() => credentialVault.getTokenForRun('nonexistent-run', 'anthropic'))
      .toThrow(/No credential scope/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. secret-scanner.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('scanWorktreeForSecrets', () => {
  beforeEach(() => mockExecFile.mockReset())

  it('returns skipped:true when gitleaks binary is not found (ENOENT)', async () => {
    const err: NodeJS.ErrnoException = Object.assign(new Error('gitleaks: ENOENT'), { code: 'ENOENT' })
    mockExecFile.mockRejectedValueOnce(err)

    const result = await scanWorktreeForSecrets('/tmp/worktree-abc')
    expect(result.skipped).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it('returns findings when gitleaks reports secrets', async () => {
    const rawFindings = [
      {
        File:        'src/config.ts',
        StartLine:   10,
        RuleID:      'generic-api-key',
        Description: 'Generic API Key',
        Entropy:     4.2,
        Secret:      'REDACTED',
        Match:       'apiKey = "REDACTED"',
      },
    ]
    mockExecFile.mockResolvedValueOnce({ stdout: JSON.stringify(rawFindings), stderr: '' })

    const result = await scanWorktreeForSecrets('/tmp/worktree-abc')
    expect(result.skipped).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.file).toBe('src/config.ts')
    expect(result.findings[0]!.line).toBe(10)
  })

  it('returns empty findings for clean worktree (empty JSON array)', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' })

    const result = await scanWorktreeForSecrets('/tmp/worktree-clean')
    expect(result.skipped).toBe(false)
    expect(result.findings).toHaveLength(0)
    expect(result.error).toBeUndefined()
  })

  it('returns error on invalid gitleaks JSON output', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: 'not-json', stderr: '' })

    const result = await scanWorktreeForSecrets('/tmp/worktree-abc')
    expect(result.error).toMatch(/parse/i)
    expect(result.findings).toHaveLength(0)
  })

  it('returns error.message in result for unexpected exec failure', async () => {
    const err = Object.assign(new Error('gitleaks crashed'), { code: 'SIGKILL' })
    mockExecFile.mockRejectedValueOnce(err)

    const result = await scanWorktreeForSecrets('/tmp/worktree-abc')
    expect(result.skipped).toBe(false)
    expect(result.error).toMatch(/crashed/)
  })

  it('returns error result for path traversal (without calling execFile)', async () => {
    const result = await scanWorktreeForSecrets('/tmp/../etc/worktree')
    expect(result.error).toMatch(/Path traversal/i)
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})
