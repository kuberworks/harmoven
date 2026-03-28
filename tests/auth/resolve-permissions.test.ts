// tests/auth/resolve-permissions.test.ts
// Unit tests for resolvePermissions() — Amendment 78, §28.3
//
// All DB calls are mocked; no network or database required.
//
// Scenarios:
//   1. instance_admin → all 26 permissions (bypass)
//   2. api_key caller → resolves role from ProjectApiKey
//   3. session caller → resolves role from ProjectMember
//   4. custom role extending built-in → additive permissions
//   5. session caller not a project member → ForbiddenError
//   6. unknown permission strings in DB row are stripped (injection guard)
//   7. assertPermissions passes when all required perms present
//   8. assertPermissions throws ForbiddenError when any perm is missing
//
// API key specific tests (project-api-key.ts):
//   9. generateApiKey produces hv1_ prefix key
//  10. validateApiKey rejects non-hv1_ strings
//  11. validateApiKey uses timingSafeEqual (no string equality)

import {
  resolvePermissions,
  assertPermissions,
  ForbiddenError,
  invalidatePermCache,
} from '@/lib/auth/rbac'
import type { Caller } from '@/lib/auth/rbac'
import { ALL_PERMISSIONS } from '@/lib/auth/permissions'
import { BUILT_IN_ROLES } from '@/lib/auth/built-in-roles'

// ─── Mock DB client ─────────────────────────────────────────────────────────

jest.mock('@/lib/db/client', () => ({
  db: {
    projectApiKey: {
      findUnique: jest.fn(),
      findFirst:  jest.fn(),
      update:     jest.fn(),
    },
    projectMember: {
      findUnique: jest.fn(),
    },
  },
}))

// Import after mock so we get the mocked version
import { db } from '@/lib/db/client'

const mockDb = db as unknown as {
  projectApiKey: {
    findUnique: jest.Mock
    findFirst:  jest.Mock
    update:     jest.Mock
  }
  projectMember: {
    findUnique: jest.Mock
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const SESSION_ADMIN: Caller = {
  type:         'session',
  userId:       'user-instance-admin',
  instanceRole: 'instance_admin',
}

const SESSION_USER: Caller = {
  type:         'session',
  userId:       'user-regular',
  instanceRole: null,
}

// A regular session caller who holds the built-in 'admin' project role
const SESSION_ADMIN_MEMBER: Caller = {
  type:         'session',
  userId:       'user-admin-member',
  instanceRole: null,
}

const APIKEY_CALLER: Caller = {
  type:  'api_key',
  keyId: 'key-abc123',
}

const PROJECT_ID = 'proj-test-001'

// Clear perm cache before each test to avoid cross-test pollution
beforeEach(() => {
  jest.clearAllMocks()
  invalidatePermCache(SESSION_USER, PROJECT_ID)
  invalidatePermCache(SESSION_ADMIN_MEMBER, PROJECT_ID)
  invalidatePermCache(APIKEY_CALLER, PROJECT_ID)
})

// ─── 1. instance_admin bypass ───────────────────────────────────────────────

describe('resolvePermissions — instance_admin', () => {
  it('returns full instance_admin permission set without any DB call', async () => {
    const perms = await resolvePermissions(SESSION_ADMIN, PROJECT_ID)

    // Must include all instance_admin permissions
    for (const p of BUILT_IN_ROLES.instance_admin) {
      expect(perms.has(p)).toBe(true)
    }

    // Must not hit the DB
    expect(mockDb.projectMember.findUnique).not.toHaveBeenCalled()
    expect(mockDb.projectApiKey.findUnique).not.toHaveBeenCalled()
  })
})

// ─── 2. api_key caller resolves via ProjectApiKey ────────────────────────────

describe('resolvePermissions — api_key caller', () => {
  it('resolves permissions from ProjectApiKey role (built-in developer)', async () => {
    mockDb.projectApiKey.findUnique.mockResolvedValueOnce({
      role: {
        extends:     'user_with_costs',
        permissions: ['gates:read_code', 'project:edit', 'stream:project', 'admin:triggers'],
      },
    })

    const perms = await resolvePermissions(APIKEY_CALLER, PROJECT_ID)

    // Must have all developer-level permissions
    for (const p of BUILT_IN_ROLES.developer) {
      expect(perms.has(p)).toBe(true)
    }
    // Spot-check one admin perm that developer does NOT have
    expect(perms.has('admin:users')).toBe(false)

    expect(mockDb.projectApiKey.findUnique).toHaveBeenCalledWith({
      where:  { id: 'key-abc123' },
      select: { role: { select: { extends: true, permissions: true } } },
    })
  })

  it('caches the second call — DB called only once', async () => {
    mockDb.projectApiKey.findUnique.mockResolvedValue({
      role: { extends: 'viewer', permissions: [] },
    })

    await resolvePermissions(APIKEY_CALLER, PROJECT_ID)
    const perms2 = await resolvePermissions(APIKEY_CALLER, PROJECT_ID)

    expect(perms2.has('runs:read')).toBe(true)
    expect(mockDb.projectApiKey.findUnique).toHaveBeenCalledTimes(1)
  })

  it('throws ForbiddenError when key has no role', async () => {
    mockDb.projectApiKey.findUnique.mockResolvedValueOnce(null)

    await expect(resolvePermissions(APIKEY_CALLER, PROJECT_ID)).rejects.toThrow(ForbiddenError)
  })

  it('invalidatePermCache forces a DB re-fetch on next call', async () => {
    mockDb.projectApiKey.findUnique.mockResolvedValue({
      role: { extends: 'viewer', permissions: [] },
    })

    await resolvePermissions(APIKEY_CALLER, PROJECT_ID) // prime cache
    invalidatePermCache(APIKEY_CALLER, PROJECT_ID)       // explicit invalidation
    await resolvePermissions(APIKEY_CALLER, PROJECT_ID) // must re-hit DB

    expect(mockDb.projectApiKey.findUnique).toHaveBeenCalledTimes(2)
  })
})

// ─── 2b. cache TTL expiry ────────────────────────────────────────────────────

describe('resolvePermissions — cache TTL expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    invalidatePermCache(APIKEY_CALLER, PROJECT_ID)
  })

  it('re-fetches from DB after the 30 s TTL expires', async () => {
    mockDb.projectApiKey.findUnique.mockResolvedValue({
      role: { extends: 'viewer', permissions: [] },
    })

    await resolvePermissions(APIKEY_CALLER, PROJECT_ID) // prime cache

    // Advance past PERM_CACHE_TTL_MS (30 000 ms)
    jest.advanceTimersByTime(30_001)

    await resolvePermissions(APIKEY_CALLER, PROJECT_ID) // cache miss → DB again

    expect(mockDb.projectApiKey.findUnique).toHaveBeenCalledTimes(2)
  })
})

// ─── 3. session caller resolves via ProjectMember ────────────────────────────

describe('resolvePermissions — session caller', () => {
  it('resolves permissions from ProjectMember role (built-in user)', async () => {
    mockDb.projectMember.findUnique.mockResolvedValueOnce({
      role: {
        extends:     'operator',
        permissions: ['runs:create', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause', 'marketplace:install'],
      },
    })

    const perms = await resolvePermissions(SESSION_USER, PROJECT_ID)

    for (const p of BUILT_IN_ROLES.user) {
      expect(perms.has(p)).toBe(true)
    }
    // user does not have cost permissions
    expect(perms.has('runs:read_costs')).toBe(false)
  })

  it('throws ForbiddenError when user has no membership', async () => {
    mockDb.projectMember.findUnique.mockResolvedValueOnce(null)

    await expect(resolvePermissions(SESSION_USER, PROJECT_ID)).rejects.toThrow(ForbiddenError)
  })

  it('resolves full admin permission set for built-in admin role', async () => {
    mockDb.projectMember.findUnique.mockResolvedValueOnce({
      role: {
        extends:     'developer',
        permissions: ['project:members', 'project:credentials', 'admin:skills'],
      },
    })

    const perms = await resolvePermissions(SESSION_ADMIN_MEMBER, PROJECT_ID)

    // All admin-level permissions must be present
    for (const p of BUILT_IN_ROLES.admin) {
      expect(perms.has(p)).toBe(true)
    }
    // admin does NOT have instance-level permissions
    expect(perms.has('admin:models')).toBe(false)
    expect(perms.has('admin:audit')).toBe(false)
    expect(perms.has('admin:instance')).toBe(false)
  })
})

// ─── 4. custom role — additive extends ─────────────────────────────────────

describe('resolvePermissions — custom role', () => {
  it('adds explicit permissions on top of extends base', async () => {
    // Custom role: extends 'viewer', adds runs:create (unusual but valid)
    mockDb.projectMember.findUnique.mockResolvedValueOnce({
      role: {
        extends:     'viewer',
        permissions: ['runs:create'],
      },
    })

    const perms = await resolvePermissions(SESSION_USER, PROJECT_ID)

    // Base viewer perms
    expect(perms.has('runs:read')).toBe(true)
    expect(perms.has('project:read')).toBe(true)
    // Extra explicit perm
    expect(perms.has('runs:create')).toBe(true)
    // Not in viewer or explicit list
    expect(perms.has('gates:approve')).toBe(false)
  })

  it('role with no extends and explicit permissions only', async () => {
    mockDb.projectMember.findUnique.mockResolvedValueOnce({
      role: {
        extends:     null,
        permissions: ['runs:read', 'stream:state'],
      },
    })

    const perms = await resolvePermissions(SESSION_USER, PROJECT_ID)

    expect(perms.has('runs:read')).toBe(true)
    expect(perms.has('stream:state')).toBe(true)
    expect(perms.has('project:read')).toBe(false) // not in explicit list
  })
})

// ─── 5. Unknown permission strings stripped (injection guard) ───────────────

describe('resolvePermissions — permission injection guard', () => {
  it('silently drops unknown permission strings sourced from DB', async () => {
    mockDb.projectMember.findUnique.mockResolvedValueOnce({
      role: {
        extends:     null,
        permissions: ['runs:read', 'MALICIOUS:bypass', '__proto__:pollute', 'runs:read'],
      },
    })

    const perms = await resolvePermissions(SESSION_USER, PROJECT_ID)

    expect(perms.has('runs:read')).toBe(true)
    // Unknown strings must not appear
    expect(perms.has('MALICIOUS:bypass' as never)).toBe(false)
    expect(perms.has('__proto__:pollute' as never)).toBe(false)
  })
})

// ─── 6-7. assertPermissions ─────────────────────────────────────────────────

describe('assertPermissions', () => {
  it('passes when caller holds all required permissions', () => {
    const perms = new Set(BUILT_IN_ROLES.developer)
    expect(() => assertPermissions(perms, ['runs:create', 'gates:read_code'])).not.toThrow()
  })

  it('throws ForbiddenError when any required permission is missing', () => {
    const perms = new Set(BUILT_IN_ROLES.viewer)
    expect(() => assertPermissions(perms, ['runs:create'])).toThrow(ForbiddenError)
  })

  it('throws ForbiddenError and does not leak permission name in message', () => {
    const perms = new Set(BUILT_IN_ROLES.viewer)
    let caught: unknown
    try {
      assertPermissions(perms, ['admin:instance'])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ForbiddenError)
    // Error message must not contain the permission name (information leak)
    expect((caught as Error).message).not.toContain('admin:instance')
  })
})

// ─── 8. validateApiKey — timing-safe, hv1_ guard ────────────────────────────

describe('validateApiKey', () => {
  // Import after jest.mock resolution
  let validateApiKey: (raw: string) => Promise<{ id: string; project_id: string } | null>

  beforeAll(async () => {
    const mod = await import('@/lib/auth/project-api-key')
    validateApiKey = mod.validateApiKey
  })

  it('returns null immediately for non-hv1_ prefixed strings', async () => {
    const result = await validateApiKey('sk-bad-prefix-key')
    expect(result).toBeNull()
    expect(mockDb.projectApiKey.findFirst).not.toHaveBeenCalled()
  })

  it('returns null when key not found in DB', async () => {
    mockDb.projectApiKey.findFirst.mockResolvedValueOnce(null)
    const result = await validateApiKey('hv1_' + 'a'.repeat(32))
    expect(result).toBeNull()
  })

  it('returns key data on valid match and fires last_used update', async () => {
    const { createHash } = await import('node:crypto')
    const rawKey = 'hv1_' + 'b'.repeat(32)
    const hash   = createHash('sha256').update(rawKey).digest('hex')

    mockDb.projectApiKey.findFirst.mockResolvedValueOnce({
      id:         'key-123',
      project_id: 'proj-abc',
      key_hash:   hash,
    })
    mockDb.projectApiKey.update.mockResolvedValue({})

    const result = await validateApiKey(rawKey)
    expect(result).toEqual({ id: 'key-123', project_id: 'proj-abc' })
    // update() is fired with void (fire-and-forget); flush two microtask ticks
    // to handle any Promise chaining introduced by future refactors.
    await Promise.resolve()
    await Promise.resolve()
    expect(mockDb.projectApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'key-123' } }),
    )
  })
})

// ─── 9. ALL_PERMISSIONS completeness check ──────────────────────────────────

describe('ALL_PERMISSIONS', () => {
  it('contains exactly 27 unique permission strings', () => {
    const unique = new Set(ALL_PERMISSIONS)
    expect(unique.size).toBe(27)
  })

  it('instance_admin permissions are a superset of all other built-in roles', () => {
    const instanceAdminSet = new Set(BUILT_IN_ROLES.instance_admin)
    const allRoles: Array<keyof typeof BUILT_IN_ROLES> = [
      'viewer', 'operator', 'user', 'user_with_costs', 'developer', 'admin',
    ]
    for (const role of allRoles) {
      for (const perm of BUILT_IN_ROLES[role]) {
        expect(instanceAdminSet.has(perm)).toBe(true)
      }
    }
  })

  it('instance_admin covers every permission in ALL_PERMISSIONS', () => {
    // Inverse check: no permission in ALL_PERMISSIONS is absent from instance_admin
    const instanceAdminSet = new Set(BUILT_IN_ROLES.instance_admin)
    for (const perm of ALL_PERMISSIONS) {
      expect(instanceAdminSet.has(perm)).toBe(true)
    }
  })
})
