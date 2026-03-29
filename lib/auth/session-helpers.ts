// lib/auth/session-helpers.ts
// Typed helpers for reading Better Auth session fields that are not part of the
// base User type (they are injected by the admin plugin at runtime).
//
// Usage:
//   import { getInstanceRole, getSessionLocale } from '@/lib/auth/session-helpers'
//   const role   = getInstanceRole(session.user)
//   const locale = getSessionLocale(session.user)

import type { SupportedLocale } from '@/lib/i18n/types'

type AnyUser = Record<string, unknown>

export type InstanceRole = 'user' | 'admin' | 'instance_admin'

/**
 * Read the instance-level role injected by the better-auth admin plugin.
 * Falls back to 'user' when the field is absent or unexpected.
 */
export function getInstanceRole(user: AnyUser): InstanceRole {
  const raw = user['role']
  if (raw === 'instance_admin' || raw === 'admin' || raw === 'user') return raw
  return 'user'
}

/**
 * Read the UI locale stored on the user record (ui_locale column).
 * Falls back to 'en'.
 */
export function getSessionLocale(user: AnyUser): SupportedLocale {
  const raw = user['ui_locale']
  if (raw === 'fr' || raw === 'en') return raw
  return 'en'
}
