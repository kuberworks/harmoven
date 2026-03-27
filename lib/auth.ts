// lib/auth.ts
// ─────────────────────────────────────────────────────────────────────────────
// Better Auth configuration — canonical instance (T1.3)
//
// This is the single betterAuth() instance used by:
//   - app/api/auth/[...all]/route.ts (HTTP handler)
//   - lib/auth/rbac.ts (session validation)
//   - middleware.ts (session guard)
//
// SECURITY:
//   - AUTH_SECRET must be set in production (≥32 bytes, from openssl rand -base64 32)
//   - AUTH_URL must match the public-facing URL exactly (CSRF protection)
//   - trustedOrigins enforces Origin header validation
// ─────────────────────────────────────────────────────────────────────────────

import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { admin } from 'better-auth/plugins/admin'
import { twoFactor } from 'better-auth/plugins/two-factor'
import { passkey } from '@better-auth/passkey'
import { apiKey } from '@better-auth/api-key'
import { db } from '@/lib/db/client'

if (!process.env.AUTH_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_SECRET environment variable is required in production')
}

// SECURITY: AUTH_SKIP_VERIFY=true disables email verification.
// This must never reach production — an operator mistake (copy from .env.dev)
// would silently allow unverified accounts.
if (process.env.AUTH_SKIP_VERIFY === 'true' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_SKIP_VERIFY cannot be set in production — it disables email verification.'
    + ' Remove it from your production environment.',
  )
}

export const auth = betterAuth({
  database: prismaAdapter(db, {
    provider: (process.env.DATABASE_PROVIDER as 'postgresql' | 'sqlite') ?? 'postgresql',
  }),

  // Secret used to sign session tokens and cookies.
  // In production: AUTH_SECRET MUST be set (≥32 bytes from `openssl rand -base64 32`).
  // In non-production: generate a random secret per-process so that session tokens
  // cannot be forged by anyone who knows the default value. Sessions are ephemeral
  // in dev anyway (in-memory, no persistence across restarts).
  secret: process.env.AUTH_SECRET ?? (() => {
    // crypto.randomUUID() is available in Node 19+ and all modern edge runtimes.
    const fallback = `dev-${Math.random().toString(36).slice(2)}-${Date.now()}`
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '[harmoven] AUTH_SECRET is not set — using a random ephemeral secret.'
        + ' Sessions will be invalidated on every process restart.'
        + ' Set AUTH_SECRET in .env for stable dev sessions.',
      )
    }
    return fallback
  })(),

  // baseURL is required for CSRF token binding and redirect validation.
  baseURL: process.env.AUTH_URL ?? 'http://localhost:3000',

  // trustedOrigins: explicitly list allowed origins for cross-origin requests.
  // Better Auth validates the Origin header against this list (CSRF protection).
  trustedOrigins: [
    process.env.AUTH_URL ?? 'http://localhost:3000',
  ],

  // ─── Email + Password ─────────────────────────────────────────────────────
  emailAndPassword: {
    enabled: true,
    // Require email verification before login (disable in dev via AUTH_SKIP_VERIFY=true)
    requireEmailVerification: process.env.AUTH_SKIP_VERIFY !== 'true',
  },

  // ─── Session ──────────────────────────────────────────────────────────────
  // SECURITY: cookie cache DISABLED — required for instant force-revocation.
  // auth.api.revokeUserSessions() must take effect immediately (spec §8, Am.78).
  // If caching were enabled, revoked sessions could still be accepted for up to
  // the cache TTL after revocation — critical for compromised admin accounts.
  session: {
    cookieCache: {
      enabled: false,
    },
  },

  // ─── Plugins ──────────────────────────────────────────────────────────────
  plugins: [
    // Admin plugin — adds role/banned/banReason/banExpires to User table.
    // The 'instance_admin' role value is Harmoven-specific; Better Auth stores it
    // as a string in user.role — resolvePermissions() reads it directly.
    admin({
      adminRole: 'instance_admin',
      defaultRole: 'user',
    }),
    // Two-factor authentication (TOTP + backup codes)
    twoFactor(),
    // Passkey (FIDO2/WebAuthn) — package: @better-auth/passkey
    // rpId must be the bare domain (no scheme/port).
    // In dev: 'localhost'. In prod: set AUTH_DOMAIN=app.harmoven.com
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Cast: @better-auth/passkey depends on @better-auth/core which duplicates
    // BetterAuthPlugin — the types are structurally identical at runtime.
    passkey({
      rpName: 'Harmoven',
      rpID: process.env.AUTH_DOMAIN ?? 'localhost',
      origin: process.env.AUTH_URL ?? 'http://localhost:3000',
    }) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    // API key management — package: @better-auth/api-key
    // Enables auth.api.apiKey.create/list/revoke for user-level keys.
    // Distinct from ProjectApiKey (project-scoped RBAC keys in lib/auth/project-api-key.ts).
    apiKey() as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ],

  // ─── Custom User Fields ───────────────────────────────────────────────────
  // These extend the User model declared in prisma/schema.prisma.
  // Amendments 45, 46.E, 86, 87.
  user: {
    additionalFields: {
      ui_score: {
        type: 'number',
        defaultValue: 0,
        required: false,
      },
      ui_level: {
        type: 'string',
        defaultValue: 'GUIDED',
        required: false,
      },
      expert_mode: {
        type: 'boolean',
        defaultValue: false,
        required: false,
      },
      preferences: {
        type: 'string',
        defaultValue: '{}',
        required: false,
      },
      // Amendment 86 — UI language: 'en' | 'fr' | null (auto-detect)
      ui_locale: {
        type: 'string',
        required: false,
      },
      // Amendment 87 — transparency feed language; null = follows ui_locale
      transparency_language: {
        type: 'string',
        required: false,
      },
    },
  },
})

// auth.$Infer.Session = { session: SessionRow, user: UserRow }
export type Session = typeof auth.$Infer.Session
// AuthUser is the user object nested inside the session — not a separate $Infer key.
export type AuthUser = typeof auth.$Infer.Session.user
