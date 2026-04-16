// tests/auth/account-deletion.test.ts
// Unit tests for lib/auth/account-deletion — RGPD Art.17 pseudonymization flow.
// All DB calls and verifyPassword are mocked — zero network, zero DB.

import { jest, describe, it, expect, beforeEach } from '@jest/globals'

// ─── Mock DB client ───────────────────────────────────────────────────────────
// Must be declared BEFORE jest.mock() calls (hoisted by Jest).

const mockTransaction             = jest.fn<(ops: unknown) => Promise<void>>()
const mockAccountFindFirst        = jest.fn<() => Promise<{ password: string } | null>>()
const mockUserDelete              = jest.fn<() => Promise<{ id: string }>>()
const mockProjectMemberDeleteMany = jest.fn<(args: unknown) => Promise<{ count: number }>>()
const mockAuditLogCreate          = jest.fn<(args: unknown) => Promise<{ id: string }>>()
const mockUpdateMany              = jest.fn<() => Promise<{ count: number }>>()
mockUpdateMany.mockResolvedValue({ count: 0 })

jest.mock('@/lib/db/client', () => ({
  db: new Proxy({}, {
    get: (_: object, prop: string) => {
      if (prop === '$transaction')   return mockTransaction
      if (prop === 'account')        return { findFirst: mockAccountFindFirst }
      if (prop === 'user')           return { delete: mockUserDelete }
      if (prop === 'projectMember')  return { deleteMany: mockProjectMemberDeleteMany, updateMany: mockUpdateMany }
      if (prop === 'auditLog')       return { create: mockAuditLogCreate }
      return { updateMany: mockUpdateMany }
    },
  }),
}))

// ─── Mock better-auth/crypto ──────────────────────────────────────────────────
// verifyPassword is mocked via module factory (Jest-hoisting-safe pattern).

jest.mock('better-auth/crypto', () => ({
  verifyPassword: jest.fn(),
}))

// ─── Mock uuidv7 ─────────────────────────────────────────────────────────────

jest.mock('@/lib/utils/uuidv7', () => ({
  uuidv7: () => 'audit-uuid-stub',
}))

// ─── Import after mocks — access mock function via jest.mocked ───────────────

import { verifyPassword }    from 'better-auth/crypto'
import {
  verifyUserPassword,
  pseudonymizeUserData,
  deleteUserAccount,
} from '@/lib/auth/account-deletion'

// Type-safe access to the mocked function
const mockVerifyPassword = jest.mocked(verifyPassword)

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function setupHappyPath() {
  mockAccountFindFirst.mockResolvedValue({ password: 'scrypt:salt:hash' })
  mockVerifyPassword.mockResolvedValue(true)
  mockTransaction.mockResolvedValue(undefined)
  mockProjectMemberDeleteMany.mockResolvedValue({ count: 0 })
  mockAuditLogCreate.mockResolvedValue({ id: 'audit-uuid-stub' })
  mockUserDelete.mockResolvedValue({ id: 'user-id-1' })
}

// ─── verifyUserPassword ───────────────────────────────────────────────────────

describe('verifyUserPassword()', () => {
  beforeEach(() => { jest.clearAllMocks() })

  it('returns true when account exists and password matches', async () => {
    mockAccountFindFirst.mockResolvedValue({ password: 'scrypt:abc' })
    mockVerifyPassword.mockResolvedValue(true)

    expect(await verifyUserPassword('user-1', 'correctPass')).toBe(true)
    expect(mockVerifyPassword).toHaveBeenCalledWith({ hash: 'scrypt:abc', password: 'correctPass' })
  })

  it('returns false when account has no password (passkey/social user)', async () => {
    mockAccountFindFirst.mockResolvedValue(null)

    expect(await verifyUserPassword('user-1', 'anyPass')).toBe(false)
    expect(mockVerifyPassword).not.toHaveBeenCalled()
  })

  it('returns false when password is wrong', async () => {
    mockAccountFindFirst.mockResolvedValue({ password: 'scrypt:abc' })
    mockVerifyPassword.mockResolvedValue(false)

    expect(await verifyUserPassword('user-1', 'wrongPass')).toBe(false)
  })
})

// ─── pseudonymizeUserData ─────────────────────────────────────────────────────

describe('pseudonymizeUserData()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTransaction.mockResolvedValue(undefined)
  })

  it('calls db.$transaction once with at least 9 operations', async () => {
    await pseudonymizeUserData('user-42')

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    const ops = (mockTransaction.mock.calls[0]?.[0] as unknown) as unknown[]
    expect(Array.isArray(ops)).toBe(true)
    expect(ops.length).toBeGreaterThanOrEqual(9)
  })
})

// ─── deleteUserAccount ────────────────────────────────────────────────────────

describe('deleteUserAccount()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setupHappyPath()
  })

  it('completes successfully with correct password', async () => {
    await expect(deleteUserAccount('user-1', 'correctPass')).resolves.toBeUndefined()

    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockProjectMemberDeleteMany).toHaveBeenCalledWith({ where: { user_id: 'user-1' } })
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actor:       'system',
          action_type: 'user.account.deleted',
          payload:     expect.objectContaining({ deleted_user_id: 'user-1' }),
        }),
      }),
    )
    expect(mockUserDelete).toHaveBeenCalledWith({ where: { id: 'user-1' } })
  })

  it('throws WRONG_PASSWORD when password does not match', async () => {
    mockVerifyPassword.mockResolvedValue(false)

    await expect(deleteUserAccount('user-1', 'bad-pass')).rejects.toMatchObject({
      code:    'WRONG_PASSWORD',
      message: 'Password is incorrect',
    })

    // Guard: pseudonymization and deletion must NOT run
    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockUserDelete).not.toHaveBeenCalled()
  })

  it('throws NO_CREDENTIAL_ACCOUNT when user has no password account', async () => {
    mockAccountFindFirst.mockResolvedValue(null)

    await expect(deleteUserAccount('user-1', 'anyPass')).rejects.toMatchObject({
      code: 'NO_CREDENTIAL_ACCOUNT',
    })

    expect(mockTransaction).not.toHaveBeenCalled()
    expect(mockUserDelete).not.toHaveBeenCalled()
  })

  it('does NOT call db.user.delete if pseudonymization transaction fails', async () => {
    mockTransaction.mockRejectedValue(new Error('DB connection lost'))

    await expect(deleteUserAccount('user-1', 'correctPass')).rejects.toThrow('DB connection lost')

    expect(mockUserDelete).not.toHaveBeenCalled()
  })

  it('includes pseudonym_ref (not only deleted_user_id) in audit payload', async () => {
    await deleteUserAccount('user-1', 'correctPass')

    const call = (mockAuditLogCreate.mock.calls[0]?.[0] as unknown) as { data: { payload: Record<string, unknown> } }
    expect(call.data.payload).toHaveProperty('pseudonym_ref')
    expect(call.data.payload).toHaveProperty('deleted_user_id', 'user-1')
  })
})
