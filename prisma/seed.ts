// prisma/seed.ts
// ─────────────────────────────────────────────────────────────────────────────
// Database seed — T1.3
//
// Idempotent: safe to re-run. Uses upsert for all rows.
//
// Seeds:
//   1. 7 built-in ProjectRole rows (global, is_builtin: true, project_id: null)
//   2. First instance_admin bootstrap (reads HARMOVEN_ADMIN_EMAIL from env)
//
// Usage:
//   npm run db:seed
//
// First-run admin bootstrap:
//   Set HARMOVEN_ADMIN_EMAIL + HARMOVEN_ADMIN_PASSWORD in .env before seeding.
//   If HARMOVEN_ADMIN_EMAIL is not set, the admin bootstrap step is skipped.
//   The admin user is created with emailVerified: true (exception for bootstrap).
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '../lib/db/client'
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_DISPLAY_NAMES,
  BUILT_IN_ROLE_EXTENDS,
  type BuiltInRoleName,
} from '../lib/auth/built-in-roles'

// ─── 1. Built-in ProjectRole rows ────────────────────────────────────────────

const BUILT_IN_ROLE_NAMES = Object.keys(BUILT_IN_ROLES) as BuiltInRoleName[]

async function seedBuiltInRoles() {
  console.log('Seeding built-in ProjectRole rows...')

  for (const name of BUILT_IN_ROLE_NAMES) {
    const permissions = [...BUILT_IN_ROLES[name]]
    const extendsRole = BUILT_IN_ROLE_EXTENDS[name] ?? null
    const displayName = BUILT_IN_ROLE_DISPLAY_NAMES[name]

    // project_id=null + name is the unique key for built-in roles.
    // Prisma upsert cannot match on null FK, so we use findFirst + update/create.
    const existing = await db.projectRole.findFirst({
      where: { project_id: null, name },
    })

    if (existing) {
      await db.projectRole.update({
        where: { id: existing.id },
        data: { display_name: displayName, permissions, extends: extendsRole },
      })
    } else {
      await db.projectRole.create({
        data: {
          project_id: null,
          name,
          display_name: displayName,
          extends: extendsRole,
          permissions,
          is_builtin: true,
          created_by: null,
        },
      })
    }

    console.log(`  ✓ ${name} (${permissions.length} permissions)`)
  }
}

// ─── 2. First instance_admin bootstrap ───────────────────────────────────────
// Creates the first admin user directly via Prisma (bypasses email verification).
// Only runs when HARMOVEN_ADMIN_EMAIL is set.
// Idempotent: skipped if user already exists.

async function seedAdminUser() {
  const email = process.env.HARMOVEN_ADMIN_EMAIL
  const password = process.env.HARMOVEN_ADMIN_PASSWORD

  if (!email) {
    console.log('HARMOVEN_ADMIN_EMAIL not set — skipping admin bootstrap.')
    return
  }

  if (!password) {
    console.warn(
      'HARMOVEN_ADMIN_PASSWORD not set — admin user will have no password. ' +
      'Set HARMOVEN_ADMIN_PASSWORD before seeding in production.',
    )
  }

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    console.log(`  ↩ Admin user already exists: ${email}`)
    return
  }

  // Hash the password using better-auth's argon2 (via the auth instance)
  // For seed purposes we use bcrypt-compatible approach via the auth API.
  // In T1.3+, the first-setup API route handles this properly.
  // Here we store a placeholder that forces a password reset.
  let passwordHash: string | null = null
  if (password) {
    // Dynamic import to avoid circular dep at top level
    const { hashPassword } = await import('../lib/auth/hash')
    passwordHash = await hashPassword(password)
  }

  await db.user.create({
    data: {
      id: crypto.randomUUID(),
      email,
      name: 'Instance Admin',
      emailVerified: true, // bootstrap exception — admin verified by convention
      role: 'instance_admin',
      createdAt: new Date(),
      updatedAt: new Date(),
      // account with password is created separately via better-auth API
    },
  })

  if (passwordHash) {
    await db.account.create({
      data: {
        id: crypto.randomUUID(),
        userId: (await db.user.findUniqueOrThrow({ where: { email } })).id,
        accountId: email,
        providerId: 'credential',
        password: passwordHash,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
  }

  console.log(`  ✓ Admin user created: ${email} (role: instance_admin)`)

  // Mark setup wizard as complete so the middleware stops redirecting to /setup.
  // The seed is only run when HARMOVEN_ADMIN_EMAIL is provided, which means the
  // admin bootstrap has been done — wizard is effectively complete.
  await db.systemSetting.upsert({
    where:  { key: 'setup.wizard_complete' },
    update: { value: 'true' },
    create: { key: 'setup.wizard_complete', value: 'true', updated_by: null },
  })
  console.log('  ✓ setup.wizard_complete = true')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await seedBuiltInRoles()
    await seedAdminUser()
    console.log('\nSeed complete.')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
