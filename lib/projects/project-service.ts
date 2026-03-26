// lib/projects/project-service.ts
// Project config update service — auto-commits to config.git on every change.
// Amendment 83 (Section 83.7).
//
// updateProjectConfig():
//   1. Updates Project.config in the DB (synchronous — request waits for this)
//   2. Auto-commits to config.git (non-blocking — never fails the request)
//
// The auto-commit is intentionally fire-and-forget for the API layer:
// a config.git write failure should NEVER roll back a valid config update.
// Failures are logged as warnings.
//
// SECURITY:
//   - projectId is validated as a UUID before any DB call.
//   - actorId is the authenticated user_id from the session.
//   - The JSON serialized to config.git is the same object written to the DB
//     (no extra sanitization needed — it's our own data going back out).

import { db }           from '@/lib/db/client'
import { configStore }  from '@/lib/config-git/config-store'

// ─── Validation ───────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertValidProjectId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`[ProjectService] Invalid projectId: "${id}"`)
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Update a project's config JSON in the DB and auto-commit the change to config.git.
 *
 * @param projectId  UUID of the project
 * @param config     New config object (must be JSON-serializable)
 * @param actorId    user_id of the person making the change (for commit message)
 * @param note       Optional human-readable description of the change
 */
export async function updateProjectConfig(
  projectId: string,
  config:    Record<string, unknown>,
  actorId:   string,
  note?:     string,
): Promise<void> {
  assertValidProjectId(projectId)

  // 1. Update DB first — this is the source of truth
  await db.project.update({
    where: { id: projectId },
    data:  { config },
  })

  // 2. Auto-commit to config.git — non-blocking, never fails the request
  configStore.set(
    {
      project_id: projectId,
      key:        'project.json',
      content:    JSON.stringify(config, null, 2),
    },
    actorId,
    note,
  ).catch(err =>
    console.warn('[ProjectService] config.git auto-commit failed', { err, projectId }),
  )
}

/**
 * Update a project's AGENTS.md override and auto-commit to config.git.
 *
 * @param projectId  UUID of the project
 * @param content    Full AGENTS.md markdown content
 * @param actorId    user_id of the person making the change
 * @param note       Optional human-readable description of the change
 */
export async function updateProjectAgentsMd(
  projectId: string,
  content:   string,
  actorId:   string,
  note?:     string,
): Promise<void> {
  assertValidProjectId(projectId)

  // AGENTS.md is stored in config.git only — not in the DB.
  await configStore.set(
    { project_id: projectId, key: 'AGENTS.md', content },
    actorId,
    note,
  )
}
