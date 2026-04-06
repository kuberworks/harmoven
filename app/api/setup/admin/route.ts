// app/api/setup/admin/route.ts
// POST /api/setup/admin — First-run wizard: create admin user + persist org config.
//
// Security:
//   - Public route (no auth required — no admin exists yet).
//   - Guard 1: setup_token — one-time server-generated token logged at startup.
//     Prevents any TCP-reachable attacker from registering as instance_admin.
//   - Guard 2: returns 409 if any user already exists (setup_complete = true).
//     Self-sealing protection against double-setup / TOCTOU attacks.
//   - Password: min 12 chars, hashed with Argon2id via better-auth/crypto.
//   - Admin created with emailVerified=true (no mail server required during setup).
//   - Org config (name, preset) written to orchestrator.yaml via patchOrchestratorConfig().
//   - Zod .strict() validation — no mass-assignment.

import { NextRequest, NextResponse }        from 'next/server'
import { z }                                from 'zod'
import { Prisma }                           from '@prisma/client'
import { hashPassword }                     from 'better-auth/crypto'
import { db }                               from '@/lib/db/client'
import { uuidv7 }                           from '@/lib/utils/uuidv7'
import { patchOrchestratorYaml }            from '@/lib/config-git/orchestrator-config'
import { verifyAndConsumeSetupToken }       from '@/lib/bootstrap/setup-token'

// ─── Validation schema ────────────────────────────────────────────────────────

const SetupAdminBody = z.object({
  // Setup token — generated at startup, printed in Docker logs
  setup_token:     z.string().min(1),
  // Step 1 fields
  org_name:        z.string().min(1).max(120),
  preset:          z.enum(['small_business', 'enterprise', 'developer']),
  // Step 2 fields
  name:            z.string().min(1).max(120),
  email:           z.string().email().max(255),
  password:        z.string().min(12).max(128),
}).strict()

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Double-setup guard ──────────────────────────────────────────────────────
  // Check SystemSetting rather than user.count() so that bootstrap seed users
  // (created by `npm run db:seed`) do not prematurely seal the wizard.
  const existingSetting = await db.systemSetting.findUnique({ where: { key: 'setup.wizard_complete' } })
  if (existingSetting?.value === 'true') {
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

  const { setup_token, org_name, preset, name, email, password } = parsed.data

  // ── Setup token verification ────────────────────────────────────────────────
  // Timing-safe compare; token is consumed (single-use) on success.
  if (!verifyAndConsumeSetupToken(setup_token)) {
    return NextResponse.json({ error: 'Invalid or expired setup token.' }, { status: 403 })
  }

  // ── Create admin user ───────────────────────────────────────────────────────
  const passwordHash = await hashPassword(password)
  const now          = new Date()
  const userId       = uuidv7()

  // Wrap in a transaction: user + credential account must both succeed or both fail.
  // Catch P2002 (unique constraint) in case of a concurrent request — TOCTOU mitigation.
  try {
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
  } catch (err: unknown) {
    // P2002: unique constraint — another concurrent request created the user first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json(
        { error: 'Setup already complete. Use Admin settings to manage users.' },
        { status: 409 },
      )
    }
    console.error('[setup/admin] Unexpected DB error during user creation:', err)
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 })
  }

  // ── Persist org config to orchestrator.yaml ─────────────────────────────────
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

  // ── Seal the wizard ─────────────────────────────────────────────────────────
  // Write setup.wizard_complete so subsequent requests to /api/auth/setup-status
  // return setup_required: false, and the middleware redirects /setup → /login.
  try {
    await db.systemSetting.upsert({
      where:  { key: 'setup.wizard_complete' },
      create: { key: 'setup.wizard_complete', value: 'true', updated_by: userId },
      update: { value: 'true', updated_by: userId },
    })
  } catch (err) {
    console.warn('[setup/admin] Failed to write setup.wizard_complete (non-fatal):', err)
  }

  return NextResponse.json({ ok: true }, { status: 201 })
}

