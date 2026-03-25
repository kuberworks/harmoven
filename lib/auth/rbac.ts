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
  // instance_admin gets full permission set — no project membership check needed
  if (
    caller.type === 'session' &&
    caller.instanceRole === 'instance_admin'
  ) {
    return new Set(BUILT_IN_ROLES.instance_admin)
  }

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
