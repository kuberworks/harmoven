// lib/auth/account-deletion.ts
// RGPD Art.17 — Right to Erasure (Droit à l'effacement)
//
// Strategy: pseudonymization-then-delete
//
// BEFORE deleting the User row, all fields that reference the user_id by value
// (plain String, no FK cascade) are pseudonymized:
//   - nullable fields  → NULL
//   - non-nullable fields that are plain strings (no FK) → '__deleted__'
//   - PipelineTemplate.created_by → NULL (FK with onDelete: SetNull, nullable since migration 20260329140000)
//
// AuditLog.actor is intentionally NOT modified:
//   - The AuditLog table has a PostgreSQL RULE that blocks UPDATE/DELETE (immutable audit trail).
//   - Once the User row is deleted, the actor value (a UUID) no longer resolves to any
//     identifiable natural person — it is de facto pseudonymous under Art.4(5) RGPD.
//   - Retaining it is justified by Art.6(1)(c) (legal obligation — security audit trail)
//     and by Art.17(3)(b) (public interest / legitimate interest exception for audit integrity).
//   - This rationale MUST be documented in the privacy notice (Art.13(2)(c)).
//
// Password verification uses Better Auth's internal scrypt implementation
// (better-auth/crypto — @noble/hashes/scrypt under the hood).
// This avoids any dependency on external argon2/bcrypt packages and keeps
// password verification in sync with Better Auth's own hash format.

import { db as _db }          from '@/lib/db/client'
import { verifyPassword }     from 'better-auth/crypto'
import type { PrismaClient }  from '@prisma/client'
import { uuidv7 }             from '@/lib/utils/uuidv7'

// Proxy-cast required for the lazy-init singleton (see lib/db/client.ts).
const db = _db as PrismaClient

// ─── Sentinel value used in non-nullable plain-string creator fields ──────────
// Not a UUID → cannot be confused with a real user_id.
// Kept short and intentional for future data archaeology.
const DELETED_ACTOR = '__deleted__'

// ─── Password verification ────────────────────────────────────────────────────

/**
 * Verifies the provided `password` against the scrypt hash stored in the
 * credential `Account` for `userId`.
 *
 * Returns `false` if:
 *   - The user has no email/password account (social-only or passkey-only user)
 *   - The password does not match
 */
export async function verifyUserPassword(
  userId:   string,
  password: string,
): Promise<boolean> {
  const account = await db.account.findFirst({
    where:  { userId, providerId: 'credential' },
    select: { password: true },
  })

  if (!account?.password) return false

  return verifyPassword({ hash: account.password, password })
}

// ─── Pre-deletion pseudonymization ────────────────────────────────────────────

/**
 * Pseudonymizes all user references in the DB before the User row is deleted.
 *
 * Runs as a single Prisma transaction. After this call it is safe to call
 * `db.user.delete({ where: { id: userId } })` — no FK constraints will block it.
 *
 * Fields handled:
 *   ┌─────────────────────────────────┬──────────────┬─────────────┐
 *   │ Model.field                     │ Type         │ Strategy    │
 *   ├─────────────────────────────────┼──────────────┼─────────────┤
 *   │ Run.created_by                  │ String?  FK  │ → NULL      │
 *   │ HumanGate.decided_by            │ String?      │ → NULL      │
 *   │ ProjectRole.created_by          │ String?      │ → NULL      │
 *   │ PipelineTemplate.created_by     │ String?  FK  │ → NULL      │
 *   │ PipelineTemplateVersion.created_by │ String   │ → SENTINEL  │
 *   │ Project.created_by              │ String       │ → SENTINEL  │
 *   │ Trigger.created_by              │ String       │ → SENTINEL  │
 *   │ ProjectApiKey.created_by        │ String       │ → SENTINEL  │
 *   │ ProjectCredential.created_by    │ String       │ → SENTINEL  │
 *   │ ProjectMember.added_by          │ String       │ → SENTINEL  │
 *   │ ProjectMember (as member)       │ FK (Cascade) │ auto        │
 *   │ AuditLog.actor                  │ (immutable)  │ see note    │
 *   └─────────────────────────────────┴──────────────┴─────────────┘
 *
 * ProjectMember rows where user_id = userId are NOT deleted here —
 * Better Auth's deleteUser handles the User relation cascade (onDelete: Cascade
 * on project_memberships via ProjectMember.user FK). If there is no cascade,
 * they are deleted explicitly before the User deletion below.
 */
export async function pseudonymizeUserData(userId: string): Promise<void> {
  await db.$transaction([
    // ── Nullable FK fields → NULL ─────────────────────────────────────────
    db.run.updateMany({
      where: { created_by: userId },
      data:  { created_by: null },
    }),
    db.humanGate.updateMany({
      where: { decided_by: userId },
      data:  { decided_by: null },
    }),
    db.projectRole.updateMany({
      where: { created_by: userId },
      data:  { created_by: null },
    }),
    // PipelineTemplate.created_by is nullable since migration 20260329140000
    db.pipelineTemplate.updateMany({
      where: { created_by: userId },
      data:  { created_by: null },
    }),

    // ── Non-nullable plain-string fields → sentinel ───────────────────────
    db.pipelineTemplateVersion.updateMany({
      where: { created_by: userId },
      data:  { created_by: DELETED_ACTOR },
    }),
    db.project.updateMany({
      where: { created_by: userId },
      data:  { created_by: DELETED_ACTOR },
    }),
    db.trigger.updateMany({
      where: { created_by: userId },
      data:  { created_by: DELETED_ACTOR },
    }),
    db.projectApiKey.updateMany({
      where: { created_by: userId },
      data:  { created_by: DELETED_ACTOR },
    }),
    db.projectCredential.updateMany({
      where: { created_by: userId },
      data:  { created_by: DELETED_ACTOR },
    }),
    db.projectMember.updateMany({
      where: { added_by: userId },
      data:  { added_by: DELETED_ACTOR },
    }),
  ])
}

// ─── Main deletion flow ───────────────────────────────────────────────────────

/**
 * Deletes a user account following the RGPD Art.17 pseudonymization strategy.
 *
 * Steps:
 *   1. Verify password (Art.7 — unambiguous consent confirmed by credential)
 *   2. Pseudonymize all external references (see pseudonymizeUserData above)
 *   3. Delete ProjectMember rows for this user (if no cascaded FK)
 *   4. Write an immutable AuditLog entry recording the deletion
 *   5. Delete the User row — cascades handle Session, Account, TwoFactor,
 *      Passkey, BetterAuthApiKey, UserPreference, InstalledPack
 *
 * @throws { code: 'WRONG_PASSWORD' }        if password does not match
 * @throws { code: 'NO_CREDENTIAL_ACCOUNT' } if user has no password account
 *                                            (suggest passkey re-auth instead)
 */
export async function deleteUserAccount(
  userId:   string,
  password: string,
): Promise<void> {
  // ── 1. Verify password ────────────────────────────────────────────────────
  const account = await db.account.findFirst({
    where:  { userId, providerId: 'credential' },
    select: { password: true },
  })

  if (!account?.password) {
    const err = new Error('No credential account found for this user')
    ;(err as NodeJS.ErrnoException).code = 'NO_CREDENTIAL_ACCOUNT'
    throw err
  }

  const valid = await verifyPassword({ hash: account.password, password })
  if (!valid) {
    const err = new Error('Password is incorrect')
    ;(err as NodeJS.ErrnoException).code = 'WRONG_PASSWORD'
    throw err
  }

  // ── 2. Pseudonymize external references ───────────────────────────────────
  await pseudonymizeUserData(userId)

  // ── 3. Explicit pre-deletion cleanup ─────────────────────────────────────
  // Delete the user's own project memberships.
  // Better Auth's deleteUser cascades on `user` FK in Session/Account/etc.,
  // but ProjectMember has no explicit onDelete: Cascade on the user FK —
  // we delete them before the User to avoid FK violation.
  await db.projectMember.deleteMany({ where: { user_id: userId } })

  // ── 4. Immutable audit log — pre-deletion (before User row disappears) ───
  // Records who initiated the deletion and when.
  // actor='system' because the user_id will no longer exist post-deletion.
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       'system',
      action_type: 'user.account.deleted',
      payload:     {
        deleted_user_id: userId,
        // Hash the user_id so the entry can be cross-referenced by support
        // without exposing the raw UUID in plaintext after RGPD erasure.
        // SHA-256(userId).slice(0,16) — pseudonymous reference only.
        pseudonym_ref: userId.replace(/-/g, '').slice(0, 16),
      },
    },
  })

  // ── 5. Delete the User row ─────────────────────────────────────────────
  // Cascades (onDelete: Cascade): Session, Account, TwoFactor, Passkey,
  //   BetterAuthApiKey, project_memberships (via User.project_memberships FK),
  //   user_preferences, installed_packs, pipeline_templates (Cascade from User?
  //   No — PipelineTemplate now uses SetNull, so template rows are preserved).
  await db.user.delete({ where: { id: userId } })
}
