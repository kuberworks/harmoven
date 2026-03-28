// lib/auth/rbac.ts
// Permission resolution — Amendment 78.3 / 28.3
//
// resolvePermissions() is the single gate for all authorization checks.
// It is called once per request and the result cached via AsyncLocalStorage (T1.8).
//
// Caller types:
//   - session: browser session from Better Auth (user.role = Better Auth admin plugin value)
//   - api_key: ProjectApiKey row (hv1_ format, Am.78)

import { db } from '@/lib/db/client'
import type { Permission } from './permissions'
import { BUILT_IN_ROLES } from './built-in-roles'
import type { BuiltInRoleName } from './built-in-roles'
import { ALL_PERMISSIONS } from './permissions'

// ─── Permission cache ─────────────────────────────────────────────────────────
// Short-lived cache keyed by "<callerId>:<projectId>" so repeated calls within
// the same request (or across calls in the same 30-second window) skip the DB.
// instance_admin is never cached — it returns early before this cache is checked.
// TTL = 30 s (DoD §T2B.1) — balances DB load with revocation promptness.

interface PermCacheEntry { perms: Set<Permission>; expiresAt: number }
const _permCache = new Map<string, PermCacheEntry>()
const PERM_CACHE_TTL_MS = 30_000

function cacheKey(caller: Caller, projectId: string): string {
  return caller.type === 'session'
    ? `session:${caller.userId}:${projectId}`
    : `apikey:${caller.keyId}:${projectId}`
}

function getCached(caller: Caller, projectId: string): Set<Permission> | null {
  const entry = _permCache.get(cacheKey(caller, projectId))
  if (!entry || Date.now() > entry.expiresAt) {
    _permCache.delete(cacheKey(caller, projectId))
    return null
  }
  return entry.perms
}

function setCached(caller: Caller, projectId: string, perms: Set<Permission>): void {
  _permCache.set(cacheKey(caller, projectId), { perms, expiresAt: Date.now() + PERM_CACHE_TTL_MS })
}

/** Invalidate cached permissions for a specific caller / project pair. */
export function invalidatePermCache(caller: Caller, projectId: string): void {
  _permCache.delete(cacheKey(caller, projectId))
}

/**
 * Invalidate all cached permission entries for a project.
 * Call this when a role *definition* changes (not just a member's role assignment)
 * since a single role change can affect every member who held that role.
 */
export function invalidateProjectPermCache(projectId: string): void {
  const suffix = `:${projectId}`
  for (const key of _permCache.keys()) {
    if (key.endsWith(suffix)) _permCache.delete(key)
  }
}

export class ForbiddenError extends Error {
  readonly status = 403
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export type SessionCaller = {
  type: 'session'
  userId: string
  instanceRole: string | null  // Better Auth admin plugin role field ('instance_admin' | null)
}

export type ApiKeyCaller = {
  type: 'api_key'
  keyId: string
}

export type Caller = SessionCaller | ApiKeyCaller

/**
 * Resolve the full set of permissions for a caller in a given project.
 *
 * instance_admin bypasses project membership — they have all permissions.
 * For regular users and API keys, the ProjectMember/ProjectApiKey row is used
 * to find the associated ProjectRole, which may extend a built-in role.
 *
 * Throws ForbiddenError if the caller has no membership in the project.
 */
export async function resolvePermissions(
  caller: Caller,
  projectId: string,
): Promise<Set<Permission>> {
  // instance_admin gets full permission set — not cached (in-memory bypass is fast enough).
  if (
    caller.type === 'session' &&
    caller.instanceRole === 'instance_admin'
  ) {
    return new Set(BUILT_IN_ROLES.instance_admin)
  }

  // Cache hit
  const cached = getCached(caller, projectId)
  if (cached) return cached

  let roleExtendsName: string | null = null
  let permissionsList: string[] = []

  if (caller.type === 'api_key') {
    const key = await db.projectApiKey.findUnique({
      where: { id: caller.keyId },
      select: { role: { select: { extends: true, permissions: true } } },
    })
    if (!key?.role) throw new ForbiddenError()
    roleExtendsName = key.role.extends ?? null
    permissionsList = key.role.permissions
  } else {
    const member = await db.projectMember.findUnique({
      where: {
        project_id_user_id: {
          project_id: projectId,
          user_id: caller.userId,
        },
      },
      select: { role: { select: { extends: true, permissions: true } } },
    })
    if (!member?.role) throw new ForbiddenError()
    roleExtendsName = member.role.extends ?? null
    permissionsList = member.role.permissions
  }

  // Start with the base permissions from the extended built-in role
  const result = new Set<Permission>()

  if (roleExtendsName && roleExtendsName in BUILT_IN_ROLES) {
    for (const p of BUILT_IN_ROLES[roleExtendsName as BuiltInRoleName]) {
      result.add(p)
    }
  }

  // Add explicit permissions declared on the role (additive).
  // Validate each entry against the canonical permission set before adding —
  // rejects any corrupt or injected string that is not a known permission.
  const permissionSet = new Set<string>(ALL_PERMISSIONS)
  for (const p of permissionsList) {
    if (permissionSet.has(p)) {
      result.add(p as Permission)
    }
  }

  setCached(caller, projectId, result)
  return result
}

/**
 * Assert that the caller has all of the required permissions.
 * Throws ForbiddenError if any permission is missing.
 * The error message is intentionally generic — never leaks permission names to the caller.
 */
export function assertPermissions(
  perms: Set<Permission>,
  required: Permission[],
): void {
  for (const p of required) {
    if (!perms.has(p)) throw new ForbiddenError()
  }
}

/**
 * Assert the caller is an instance_admin session.
 * Use this for all instance-level routes (/api/admin/*) to replace inline
 * `caller.instanceRole === 'instance_admin'` checks.
 *
 * After this call TypeScript narrows `caller` to `SessionCaller`.
 * Throws ForbiddenError (403). API keys are rejected — they cannot hold instance-level scope.
 */
export function assertInstanceAdmin(caller: Caller): asserts caller is SessionCaller {
  if (caller.type !== 'session') {
    throw new ForbiddenError('API keys cannot access instance-admin routes')
  }
  if (caller.instanceRole !== 'instance_admin') {
    throw new ForbiddenError()
  }
}
