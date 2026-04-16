// lib/auth/ownership.ts
// IDOR (Insecure Direct Object Reference) enforcement — Amendment 78 / OWASP A01
//
// All API route handlers that access a Run or Project by ID must call
// assertRunAccess() or assertProjectAccess() before returning any data.
// These functions verify both existence and caller membership.

import { db } from '@/lib/db/client'
import { ForbiddenError, UnauthorizedError } from './rbac'
import type { Caller } from './rbac'

/**
 * Assert that a project exists and the caller is a member (or instance_admin).
 * Returns the project row so callers don't need a second DB fetch.
 *
 * Throws UnauthorizedError if no caller.
 * Throws ForbiddenError if project not found or caller has no membership.
 */
export async function assertProjectAccess(
  caller: Caller | null,
  projectId: string,
) {
  if (!caller) throw new UnauthorizedError()

  const project = await db.project.findUnique({
    where: { id: projectId },
  })
  if (!project) throw new ForbiddenError()

  // instance_admin bypasses membership check
  if (caller.type === 'session' && caller.instanceRole === 'instance_admin') {
    return project
  }

  // Verify membership exists (role resolution happens separately via resolvePermissions)
  if (caller.type === 'session') {
    const member = await db.projectMember.findUnique({
      where: {
        project_id_user_id: { project_id: projectId, user_id: caller.userId },
      },
      select: { project_id: true },
    })
    if (!member) throw new ForbiddenError()
  } else {
    // API key — key must belong to this project
    const key = await db.projectApiKey.findUnique({
      where: { id: caller.keyId },
      select: { project_id: true, revoked_at: true, expires_at: true },
    })
    if (!key || key.project_id !== projectId) throw new ForbiddenError()
    if (key.revoked_at) throw new ForbiddenError('API key revoked')
    if (key.expires_at && key.expires_at < new Date()) throw new ForbiddenError('API key expired')
  }

  return project
}

/**
 * Assert that a run exists and belongs to the given project.
 * assertProjectAccess must have been called before this.
 * Returns the run row.
 *
 * Throws ForbiddenError if run not found or belongs to a different project.
 */
export async function assertRunAccess(runId: string, projectId: string) {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      project_id: true,
      status: true,
      created_by: true,
    },
  })
  // Return same error for not-found and wrong-project to prevent enumeration
  if (!run || run.project_id !== projectId) throw new ForbiddenError()
  return run
}
