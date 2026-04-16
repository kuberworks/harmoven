// prisma/seed-runner.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Standalone seed script — no TypeScript, no @/ path aliases, no tsconfig.
// Safe to run with plain `node prisma/seed-runner.mjs` inside the Docker
// container after `prisma migrate deploy`.
//
// Idempotent: uses findFirst + update/create (upsert) — safe to re-run.
//
// Seeds:
//   1. 7 built-in ProjectRole rows (global, is_builtin: true, project_id: null)
//   2. First instance_admin bootstrap (reads HARMOVEN_ADMIN_EMAIL from env)
// ─────────────────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { hashPassword as baHashPassword } from 'better-auth/crypto'

// ─── Inline role definitions (mirrors lib/auth/built-in-roles.ts) ─────────────
// Kept inline so this script has ZERO internal dependencies.

const BUILT_IN_ROLES = {
  viewer:          ['runs:read', 'stream:state', 'project:read'],
  operator:        ['runs:read', 'stream:state', 'project:read', 'stream:gates', 'gates:read', 'gates:write', 'gates:approve', 'gates:read_critical'],
  user:            ['runs:read', 'stream:state', 'project:read', 'stream:gates', 'gates:read', 'gates:write', 'gates:approve', 'gates:read_critical', 'runs:create', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause', 'marketplace:install'],
  user_with_costs: ['runs:read', 'stream:state', 'project:read', 'stream:gates', 'gates:read', 'gates:write', 'gates:approve', 'gates:read_critical', 'runs:create', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause', 'marketplace:install', 'runs:read_costs', 'stream:costs'],
  developer:       ['runs:read', 'stream:state', 'project:read', 'stream:gates', 'gates:read', 'gates:write', 'gates:approve', 'gates:read_critical', 'runs:create', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause', 'marketplace:install', 'runs:read_costs', 'stream:costs', 'gates:read_code', 'project:edit', 'stream:project', 'admin:triggers'],
  admin:           ['runs:read', 'stream:state', 'project:read', 'stream:gates', 'gates:read', 'gates:write', 'gates:approve', 'gates:read_critical', 'runs:create', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause', 'marketplace:install', 'runs:read_costs', 'stream:costs', 'gates:read_code', 'project:edit', 'stream:project', 'admin:triggers', 'project:members', 'project:credentials', 'admin:integrations'],
  instance_admin:  ['runs:read', 'stream:state', 'project:read', 'stream:gates', 'gates:read', 'gates:write', 'gates:approve', 'gates:read_critical', 'runs:create', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause', 'marketplace:install', 'runs:read_costs', 'stream:costs', 'gates:read_code', 'project:edit', 'stream:project', 'admin:triggers', 'project:members', 'project:credentials', 'admin:integrations', 'admin:models', 'admin:users', 'admin:audit', 'admin:instance'],
}

const BUILT_IN_ROLE_DISPLAY_NAMES = {
  viewer:          'Viewer',
  operator:        'Operator',
  user:            'User',
  user_with_costs: 'User with Costs',
  developer:       'Developer',
  admin:           'Admin',
  instance_admin:  'Instance Admin',
}

const BUILT_IN_ROLE_EXTENDS = {
  operator:        'viewer',
  user:            'operator',
  user_with_costs: 'user',
  developer:       'user_with_costs',
  admin:           'developer',
  instance_admin:  'admin',
}

// ─── DB client ────────────────────────────────────────────────────────────────

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('[seed] DATABASE_URL is not set — aborting.')
  process.exit(1)
}

const adapter = new PrismaPg({ connectionString })
const db = new PrismaClient({ adapter })

// ─── 1. Built-in ProjectRole rows ─────────────────────────────────────────────

async function seedBuiltInRoles() {
  console.log('[seed] Seeding built-in ProjectRole rows...')
  for (const [name, permissions] of Object.entries(BUILT_IN_ROLES)) {
    const displayName = BUILT_IN_ROLE_DISPLAY_NAMES[name]
    const extendsRole = BUILT_IN_ROLE_EXTENDS[name] ?? null

    const existing = await db.projectRole.findFirst({
      where: { project_id: null, name },
    })

    if (existing) {
      await db.projectRole.update({
        where: { id: existing.id },
        data: { display_name: displayName, permissions, extends: extendsRole },
      })
      console.log(`[seed]   ↩ updated ${name}`)
    } else {
      await db.projectRole.create({
        data: {
          project_id:   null,
          name,
          display_name: displayName,
          extends:      extendsRole,
          permissions,
          is_builtin:   true,
          created_by:   null,
        },
      })
      console.log(`[seed]   ✓ created ${name}`)
    }
  }
}

// ─── 2. First instance_admin bootstrap ────────────────────────────────────────

async function seedAdminUser() {
  const email    = process.env.HARMOVEN_ADMIN_EMAIL
  const password = process.env.HARMOVEN_ADMIN_PASSWORD

  if (!email) {
    console.log('[seed] HARMOVEN_ADMIN_EMAIL not set — skipping admin bootstrap.')
    return
  }

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    console.log(`[seed]   ↩ Admin user already exists: ${email}`)
    return
  }

  // Hash password with bcrypt (available in node std libs via crypto)
  // For production bootstrap, Better Auth argon2 is preferred — but at seed
  // time we use a simpler hash that Better Auth's credential provider accepts.
  // Better Auth stores passwords as argon2 hashes; if this bootstrap hash
  // format differs, the operator should reset via the setup wizard instead.
  if (!password) {
    console.warn('[seed] HARMOVEN_ADMIN_PASSWORD not set — creating user without password.')
  }

  let passwordHash = null
  if (password) {
    // Use better-auth's own crypto layer (always available when better-auth is installed).
    passwordHash = await baHashPassword(password)
  }

  const userId = crypto.randomUUID()
  await db.user.create({
    data: {
      id:            userId,
      email,
      name:          'Instance Admin',
      emailVerified: true,
      role:          'instance_admin',
      createdAt:     new Date(),
      updatedAt:     new Date(),
    },
  })

  if (passwordHash) {
    await db.account.create({
      data: {
        id:         crypto.randomUUID(),
        userId,
        accountId:  email,
        providerId: 'credential',
        password:   passwordHash,
        createdAt:  new Date(),
        updatedAt:  new Date(),
      },
    })
  }

  console.log(`[seed]   ✓ Admin user created: ${email} (role: instance_admin)`)

  // Mark setup wizard complete — prevents middleware from redirecting to /setup
  await db.systemSetting.upsert({
    where:  { key: 'setup.wizard_complete' },
    update: { value: 'true' },
    create: { key: 'setup.wizard_complete', value: 'true', updated_by: null },
  })
  console.log('[seed]   ✓ setup.wizard_complete = true')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await seedBuiltInRoles()
    await seedAdminUser()
    console.log('[seed] Complete.')
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => {
  console.error('[seed] Fatal error:', e)
  process.exit(1)
})
