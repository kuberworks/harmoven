'use client'

// components/shared/PermissionGuard.tsx
// Renders children only if the current user has the given permission.
// On 403 / missing permission → renders nothing (never disables, always hides).
// Spec: FRONTEND-SDD-PROMPT.md RBAC rules, DESIGN_SYSTEM.md principle 13.

import { type ReactNode } from 'react'
import type { Permission } from '@/lib/auth/permissions'

interface PermissionGuardProps {
  /** The permission required to render children */
  permission: Permission
  /** Set of permissions resolved for the current user + project */
  permissions: Set<Permission>
  /** Optional fallback rendered when permission is absent (default: null) */
  fallback?: ReactNode
  children: ReactNode
}

export function PermissionGuard({ permission, permissions, fallback = null, children }: PermissionGuardProps) {
  if (!permissions.has(permission)) return <>{fallback}</>
  return <>{children}</>
}
