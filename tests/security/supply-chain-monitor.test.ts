// tests/security/supply-chain-monitor.test.ts
// Unit tests for lib/security/supply-chain-monitor.ts
// All DB writes are mocked — no database required.

import {
  recordSupplyChainEvent,
  reportImageDigestMismatch,
  reportPackSignatureInvalid,
  reportPackHashMismatch,
  reportMCPSkillHashMismatch,
  reportUpdateWithoutRelease,
  reportLiteLLMVersionDrift,
  type SupplyChainEvent,
} from '@/lib/security/supply-chain-monitor'

// ─── Mock the Prisma db client ────────────────────────────────────────────────

const mockAuditLogCreate = jest.fn().mockResolvedValue({ id: 'mock-id' })

jest.mock('@/lib/db/client', () => ({
  db: {
    auditLog: {
      create: (...args: unknown[]) => mockAuditLogCreate(...args),
    },
  },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lastCall() {
  return mockAuditLogCreate.mock.calls.at(-1)?.[0]?.data as Record<string, unknown>
}

// ─── recordSupplyChainEvent ───────────────────────────────────────────────────

describe('recordSupplyChainEvent', () => {
  beforeEach(() => jest.clearAllMocks())

  it('writes to AuditLog with correct action_type', async () => {
    await recordSupplyChainEvent({
      event_type: 'pack_signature_invalid',
      detail:     'GPG verify failed',
      context:    { pack_id: 'my_pack', version: '1.0.0' },
    })

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
    const data = lastCall()
    expect(data.action_type).toBe('supply_chain.pack_signature_invalid')
    expect((data.payload as Record<string, unknown>).severity).toBe('critical')
    expect((data.payload as Record<string, unknown>).detail).toContain('GPG verify failed')
  })

  it('uses actorId=system by default', async () => {
    await recordSupplyChainEvent({ event_type: 'litellm_version_drift', detail: 'drift' })
    const data = lastCall()
    expect(data.actor).toBe('system')
  })

  it('accepts a custom actorId', async () => {
    await recordSupplyChainEvent({ event_type: 'dependency_version_mismatch', detail: 'd' }, 'ci-bot')
    expect(lastCall().actor).toBe('ci-bot')
  })

  it('does not throw if AuditLog write fails (degrades gracefully)', async () => {
    mockAuditLogCreate.mockRejectedValueOnce(new Error('DB down'))
    // Must not throw — supply chain monitor failure should not crash the app
    await expect(
      recordSupplyChainEvent({ event_type: 'image_digest_mismatch', detail: 'x' })
    ).resolves.toBeUndefined()
  })
})

// ─── Convenience wrappers ─────────────────────────────────────────────────────

describe('reportImageDigestMismatch', () => {
  beforeEach(() => jest.clearAllMocks())

  it('logs event with correct image context', async () => {
    await reportImageDigestMismatch({
      imageTag: 'harmoven/app:1.2.3',
      expected: 'sha256:' + 'a'.repeat(64),
      actual:   'sha256:' + 'b'.repeat(64),
    })
    const payload = lastCall().payload as Record<string, unknown>
    expect(payload.severity).toBe('critical')
    const ctx = payload.context as Record<string, string>
    expect(ctx.image_tag).toBe('harmoven/app:1.2.3')
  })
})

describe('reportPackSignatureInvalid', () => {
  beforeEach(() => jest.clearAllMocks())

  it('includes pack_id and version in context', async () => {
    await reportPackSignatureInvalid({ packId: 'slug_gen', version: '2.1.0', reason: 'bad sig' })
    const payload = lastCall().payload as Record<string, unknown>
    const ctx = payload.context as Record<string, string>
    expect(ctx.pack_id).toBe('slug_gen')
    expect(ctx.version).toBe('2.1.0')
    expect(ctx.reason).toBe('bad sig')
  })
})

describe('reportPackHashMismatch', () => {
  beforeEach(() => jest.clearAllMocks())

  it('stores expected and actual hashes', async () => {
    await reportPackHashMismatch({
      packId:   'hash_test',
      version:  '1.0.0',
      expected: 'a'.repeat(64),
      actual:   'b'.repeat(64),
    })
    const ctx = (lastCall().payload as Record<string, unknown>).context as Record<string, string>
    expect(ctx.expected).toBe('a'.repeat(64))
    expect(ctx.actual).toBe('b'.repeat(64))
  })
})

describe('reportMCPSkillHashMismatch', () => {
  beforeEach(() => jest.clearAllMocks())

  it('includes skill_name and hashes', async () => {
    await reportMCPSkillHashMismatch({
      skillName: 'my-mcp-skill',
      version:   '0.9.0',
      expected:  'c'.repeat(64),
      actual:    'd'.repeat(64),
    })
    const ctx = (lastCall().payload as Record<string, unknown>).context as Record<string, string>
    expect(ctx.skill_name).toBe('my-mcp-skill')
  })
})

describe('reportUpdateWithoutRelease', () => {
  beforeEach(() => jest.clearAllMocks())

  it('is severity=warning', async () => {
    await reportUpdateWithoutRelease({ version: '2.0.0', imageTag: 'harmoven/app:edge' })
    const payload = lastCall().payload as Record<string, unknown>
    expect(payload.severity).toBe('warning')
  })
})

describe('reportLiteLLMVersionDrift', () => {
  beforeEach(() => jest.clearAllMocks())

  it('is severity=critical and mentions both versions', async () => {
    await reportLiteLLMVersionDrift({ expected: '1.82.6', actual: '1.99.0' })
    const payload = lastCall().payload as Record<string, unknown>
    expect(payload.severity).toBe('critical')
    const detail = payload.detail as string
    expect(detail).toContain('1.82.6')
    expect(detail).toContain('1.99.0')
  })
})
