// tests/auth/maintenance.test.ts
// Unit tests for lib/maintenance — RGPD-03 (session cleanup) + RGPD-04 (run data TTL).

import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// ─── Mock DB client ───────────────────────────────────────────────────────────

const mockSessionDeleteMany  = jest.fn<(args: unknown) => Promise<{ count: number }>>()
const mockRunFindMany        = jest.fn<(args: unknown) => Promise<unknown[]>>()
const mockRunUpdateMany      = jest.fn<(args: unknown) => Promise<{ count: number }>>()
const mockNodeUpdateMany     = jest.fn<(args: unknown) => Promise<{ count: number }>>()
const mockTransaction        = jest.fn<(ops: unknown) => Promise<unknown[]>>()

jest.mock('@/lib/db/client', () => ({
  db: new Proxy({}, {
    get: (_: object, prop: string) => {
      if (prop === 'session')      return { deleteMany: mockSessionDeleteMany }
      if (prop === 'run')          return { findMany: mockRunFindMany, updateMany: mockRunUpdateMany }
      if (prop === 'node')         return { updateMany: mockNodeUpdateMany }
      if (prop === '$transaction') return mockTransaction
      return {}
    },
  }),
}))

// ─── Mock node-cron ───────────────────────────────────────────────────────────

const mockCronSchedule = jest.fn<() => { stop: () => void }>()
mockCronSchedule.mockReturnValue({ stop: jest.fn() })

jest.mock('node-cron', () => ({
  default: { schedule: (...args: unknown[]) => mockCronSchedule(...args) },
  schedule: (...args: unknown[]) => mockCronSchedule(...args),
}))

import { purgeExpiredSessions, startSessionCleanupCron } from '@/lib/maintenance/session-cleanup'
import { purgeExpiredRunData, computeDataExpiresAt, DATA_RETENTION_DAYS } from '@/lib/maintenance/run-data-ttl'

// ─── session-cleanup ──────────────────────────────────────────────────────────

describe('purgeExpiredSessions()', () => {
  beforeEach(() => { jest.clearAllMocks() })

  it('calls db.session.deleteMany with expiresAt < now', async () => {
    mockSessionDeleteMany.mockResolvedValue({ count: 5 })

    const count = await purgeExpiredSessions()
    expect(count).toBe(5)

    expect(mockSessionDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expiresAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    )
  })

  it('returns 0 when no sessions are expired', async () => {
    mockSessionDeleteMany.mockResolvedValue({ count: 0 })
    expect(await purgeExpiredSessions()).toBe(0)
  })
})

describe('startSessionCleanupCron()', () => {
  beforeEach(() => { jest.clearAllMocks(); mockSessionDeleteMany.mockResolvedValue({ count: 0 }) })

  it('schedules a cron at 03:00 daily', () => {
    startSessionCleanupCron()
    expect(mockCronSchedule).toHaveBeenCalledWith(
      '0 3 * * *',
      expect.any(Function),
    )
  })

  it('returns a task handle with a stop() method', () => {
    const task = startSessionCleanupCron()
    expect(task).toHaveProperty('stop')
  })
})

// ─── run-data-ttl ─────────────────────────────────────────────────────────────

describe('purgeExpiredRunData()', () => {
  beforeEach(() => { jest.clearAllMocks() })

  it('returns { runs: 0, nodes: 0 } when no runs are expired', async () => {
    mockRunFindMany.mockResolvedValue([])

    const result = await purgeExpiredRunData()
    expect(result).toEqual({ runs: 0, nodes: 0 })
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('calls $transaction with run + node updateMany for expired runs', async () => {
    mockRunFindMany.mockResolvedValue([{ id: 'run-1' }, { id: 'run-2' }])
    mockTransaction.mockResolvedValue([{ count: 2 }, { count: 8 }])

    const result = await purgeExpiredRunData()
    expect(result).toEqual({ runs: 2, nodes: 8 })
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })

  it('passes expired run IDs to updateMany (run)', async () => {
    mockRunFindMany.mockResolvedValue([{ id: 'run-42' }])
    mockTransaction.mockResolvedValue([{ count: 1 }, { count: 3 }])

    await purgeExpiredRunData()

    const transactionOps = (mockTransaction.mock.calls[0]?.[0] as unknown) as unknown[]
    expect(Array.isArray(transactionOps)).toBe(true)
    // Should be exactly 2 operations: run update + node update
    expect(transactionOps).toHaveLength(2)
  })

  it('queries runs with data_expires_at < now', async () => {
    mockRunFindMany.mockResolvedValue([])

    await purgeExpiredRunData()

    expect(mockRunFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          data_expires_at: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    )
  })
})

describe('computeDataExpiresAt()', () => {
  it('returns a date DATA_RETENTION_DAYS days in the future', () => {
    const base    = new Date('2026-01-01T00:00:00.000Z')
    const expires = computeDataExpiresAt(base)

    const diffMs   = expires.getTime() - base.getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeCloseTo(DATA_RETENTION_DAYS, 0)
  })

  it('defaults to now when no date is provided', () => {
    const before = Date.now()
    const expires = computeDataExpiresAt()
    const after  = Date.now()

    const baseMs = expires.getTime() - DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000
    expect(baseMs).toBeGreaterThanOrEqual(before)
    expect(baseMs).toBeLessThanOrEqual(after)
  })
})
