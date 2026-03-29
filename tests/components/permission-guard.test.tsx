/**
 * @jest-environment jsdom
 */
// tests/components/permission-guard.test.tsx
// Unit tests for PermissionGuard — the RBAC rendering guard.
// This is a 'use client' component: renders children only when the user has the
// required permission. Any regression here can silently expose privileged UI.

import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PermissionGuard } from '@/components/shared/PermissionGuard'
import type { Permission } from '@/lib/auth/permissions'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePermSet(...perms: Permission[]): Set<Permission> {
  return new Set(perms)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PermissionGuard', () => {
  it('renders children when the user has the required permission', () => {
    const perms = makePermSet('runs:create', 'project:read')

    render(
      <PermissionGuard permission="runs:create" permissions={perms}>
        <button>Create Run</button>
      </PermissionGuard>,
    )

    expect(screen.getByRole('button', { name: 'Create Run' })).toBeInTheDocument()
  })

  it('renders nothing when the user lacks the required permission', () => {
    const perms = makePermSet('project:read')  // no runs:create

    const { container } = render(
      <PermissionGuard permission="runs:create" permissions={perms}>
        <button>Create Run</button>
      </PermissionGuard>,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // Container should be empty (not just hidden — never expose to AT)
    expect(container.firstChild).toBeNull()
  })

  it('renders the fallback when the user lacks the permission', () => {
    const perms = makePermSet('project:read')

    render(
      <PermissionGuard
        permission="gates:approve"
        permissions={perms}
        fallback={<span>Access denied</span>}
      >
        <button>Approve</button>
      </PermissionGuard>,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('Access denied')).toBeInTheDocument()
  })

  it('does NOT render the fallback when the user has the permission', () => {
    const perms = makePermSet('gates:approve')

    render(
      <PermissionGuard
        permission="gates:approve"
        permissions={perms}
        fallback={<span>Access denied</span>}
      >
        <button>Approve</button>
      </PermissionGuard>,
    )

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByText('Access denied')).not.toBeInTheDocument()
  })

  it('uses an empty set as default (no perms → nothing rendered)', () => {
    const emptyPerms: Set<Permission> = new Set()

    const { container } = render(
      <PermissionGuard permission="project:edit" permissions={emptyPerms}>
        <div>Settings</div>
      </PermissionGuard>,
    )

    expect(container.firstChild).toBeNull()
  })

  it('handles multiple simultaneous guards correctly (each independent)', () => {
    const perms = makePermSet('runs:read', 'project:edit')

    render(
      <div>
        <PermissionGuard permission="runs:read"   permissions={perms}>
          <span>Runs list</span>
        </PermissionGuard>
        <PermissionGuard permission="runs:create" permissions={perms}>
          <span>Create run button</span>
        </PermissionGuard>
        <PermissionGuard permission="project:edit" permissions={perms}>
          <span>Project settings</span>
        </PermissionGuard>
      </div>,
    )

    // Only the two granted perms should render
    expect(screen.getByText('Runs list')).toBeInTheDocument()
    expect(screen.queryByText('Create run button')).not.toBeInTheDocument()
    expect(screen.getByText('Project settings')).toBeInTheDocument()
  })
})
