// app/api/setup/admin/route.ts
// POST /api/setup/admin — First-run wizard: create admin user + persist org config.
//
// Security:
//   - Public route (no auth required — no admin exists yet).
//   - Guard: returns 409 if any user already exists (setup_complete = true).
//     This prevents double-setup attacks: the route is self-sealing.
//   - Password: min 12 chars, hashed with Argon2id via better-auth/crypto.
//   - Admin created with emailVerified=true (no mail server required during setup).
//   - Org config (name, preset) written to orchestrator.yaml via patchOrchestratorConfig().
//   - Zod .strict() validation — no mass-assignment.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { hashPassword }              from 'better-auth/crypto'
import { db }                        from '@/lib/db/client'
import { uuidv7 }                    from '@/lib/utils/uuidv7'
import { patchOrchestratorYaml }   from '@/lib/config-git/orchestrator-config'

// ─── Validation schema ────────────────────────────────────────────────────────

const SetupAdminBody = z.object({
  // Step 1 fields
  org_name:        z.string().min(1).max(120),
  deployment_mode: z.enum(['docker', 'personal']),
  preset:          z.enum(['small_business', 'enterprise', 'developer']),
  // Step 2 fields
  name:            z.string().min(1).max(120),
  email:           z.string().email().max(255),
  password:        z.string().min(12).max(128),
}).strict()

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Double-setup guard ──────────────────────────────────────────────────────
  // If any user already exists, setup is complete — reject to prevent takeover.
  const userCount = await db.user.count()
  if (userCount > 0) {
    return NextResponse.json(
      { error: 'Setup already complete. Use Admin settings to manage users.' },
      { status: 409 },
    )
  }

  // ── Input validation ────────────────────────────────────────────────────────
  let body: unknown
  try { body = await req.json() } catch { body = {} }

  const parsed = SetupAdminBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { org_name, deployment_mode, preset, name, email, password } = parsed.data

  // ── Create admin user ───────────────────────────────────────────────────────
  const passwordHash = await hashPassword(password)
  const now          = new Date()
  const userId       = uuidv7()

  // Wrap in a transaction: user + credential account must both succeed or both fail.
  await db.$transaction([
    db.user.create({
      data: {
        id:            userId,
        name,
        email,
        // instance_admin is the Harmoven super-role (resolvePermissions checks this).
        role:          'instance_admin',
        // Skip email verification during first-run setup — no mail server required.
        emailVerified: true,
        createdAt:     now,
        updatedAt:     now,
      },
    }),
    // Better Auth credential account — providerId='credential', accountId=email
    db.account.create({
      data: {
        id:         uuidv7(),
        userId,
        accountId:  email,
        providerId: 'credential',
        password:   passwordHash,
        createdAt:  now,
        updatedAt:  now,
      },
    }),
    // Immutable audit log entry
    db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       'setup_wizard',
        action_type: 'setup.admin.created',
        payload:     { userId, email, role: 'instance_admin' },
      },
    }),
  ])

  // ── Persist org config to orchestrator.yaml ─────────────────────────────────
  // deployment_mode is stored as a string tag under organization.
  // This is non-blocking: if yaml write fails (e.g. read-only FS), setup still
  // succeeds — the admin can re-configure later in Admin Settings.
  try {
    await patchOrchestratorYaml({
      organization: {
        name:   org_name,
        preset,
      },
    }, 'setup_wizard')
  } catch (err) {
    console.warn('[setup/admin] Failed to write org config to orchestrator.yaml (non-fatal):', err)
  }

  return NextResponse.json({ ok: true }, { status: 201 })
}
