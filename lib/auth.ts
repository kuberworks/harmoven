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
import { db } from '@/lib/db/client'

if (!process.env.AUTH_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('AUTH_SECRET environment variable is required in production')
}

export const auth = betterAuth({
  database: prismaAdapter(db, {
    provider: (process.env.DATABASE_PROVIDER as 'postgresql' | 'sqlite') ?? 'postgresql',
  }),

  // Secret used to sign session tokens and cookies.
  // Falls back to a dev placeholder — NEVER ship to production without AUTH_SECRET set.
  secret: process.env.AUTH_SECRET ?? 'dev-secret-change-me-in-production',

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

  // ─── Email sending ────────────────────────────────────────────────────────
  // Used for: magic links, email verification, password reset.
  // Configure SMTP_* or RESEND_API_KEY in .env.
  // In development (AUTH_SKIP_VERIFY=true), email sending is skipped entirely.
  ...(process.env.SMTP_HOST
    ? {
        emailAndPassword: {
          enabled: true,
          requireEmailVerification: process.env.AUTH_SKIP_VERIFY !== 'true',
        },
      }
    : {}),

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

export type Session = typeof auth.$Infer.Session
export type AuthUser = typeof auth.$Infer.User
