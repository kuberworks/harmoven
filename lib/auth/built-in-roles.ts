// lib/auth/built-in-roles.ts
// 7 immutable built-in roles — Amendment 78.2 / 28.2
// Permissions are ADDITIVE: each role inherits all permissions of the role
// it "extends", plus its own explicit additions.
//
// These are the canonical source for:
//   - prisma/seed.ts (seeded as ProjectRole rows with is_builtin: true)
//   - resolvePermissions() (used to expand role.extends at runtime)

import type { Permission } from './permissions'

export type BuiltInRoleName =
  | 'viewer'
  | 'operator'
  | 'user'
  | 'user_with_costs'
  | 'developer'
  | 'admin'
  | 'instance_admin'

// Each entry lists the FULL resolved permission set for that role.
// resolvePermissions() uses role.extends to rebuild at runtime,
// but this table allows fast lookup without DB round-trips.
export const BUILT_IN_ROLES: Record<BuiltInRoleName, readonly Permission[]> = {
  viewer: [
    'runs:read',
    'stream:state',
    'project:read',
  ],

  operator: [
    'runs:read',
    'stream:state',
    'project:read',
    // additions over viewer:
    'stream:gates',
    'gates:read',
    'gates:write',
    'gates:approve',
    'gates:read_critical',
  ],

  user: [
    'runs:read',
    'stream:state',
    'project:read',
    'stream:gates',
    'gates:read',
    'gates:write',
    'gates:approve',
    'gates:read_critical',
    // additions over operator:
    'runs:create',
    'runs:abort',
    'runs:replay',
    'runs:inject',
    'runs:pause',
    'marketplace:install',
  ],

  user_with_costs: [
    'runs:read',
    'stream:state',
    'project:read',
    'stream:gates',
    'gates:read',
    'gates:write',
    'gates:approve',
    'gates:read_critical',
    'runs:create',
    'runs:abort',
    'runs:replay',
    'runs:inject',
    'runs:pause',
    'marketplace:install',
    // additions over user:
    'runs:read_costs',
    'stream:costs',
  ],

  developer: [
    'runs:read',
    'stream:state',
    'project:read',
    'stream:gates',
    'gates:read',
    'gates:write',
    'gates:approve',
    'gates:read_critical',
    'runs:create',
    'runs:abort',
    'runs:replay',
    'runs:inject',
    'runs:pause',
    'marketplace:install',
    'runs:read_costs',
    'stream:costs',
    // additions over user_with_costs:
    'gates:read_code',
    'project:edit',
    'stream:project',
    'admin:triggers',
  ],

  admin: [
    'runs:read',
    'stream:state',
    'project:read',
    'stream:gates',
    'gates:read',
    'gates:write',
    'gates:approve',
    'gates:read_critical',
    'runs:create',
    'runs:abort',
    'runs:replay',
    'runs:inject',
    'runs:pause',
    'marketplace:install',
    'runs:read_costs',
    'stream:costs',
    'gates:read_code',
    'project:edit',
    'stream:project',
    'admin:triggers',
    // additions over developer:
    'project:members',
    'project:credentials',
    'admin:integrations',
  ],

  instance_admin: [
    'runs:read',
    'stream:state',
    'project:read',
    'stream:gates',
    'gates:read',
    'gates:write',
    'gates:approve',
    'gates:read_critical',
    'runs:create',
    'runs:abort',
    'runs:replay',
    'runs:inject',
    'runs:pause',
    'marketplace:install',
    'runs:read_costs',
    'stream:costs',
    'gates:read_code',
    'project:edit',
    'stream:project',
    'admin:triggers',
    'project:members',
    'project:credentials',
    'admin:integrations',
    // additions over admin:
    'admin:models',
    'admin:users',
    'admin:audit',
    'admin:instance',
  ],
} as const

export const BUILT_IN_ROLE_DISPLAY_NAMES: Record<BuiltInRoleName, string> = {
  viewer:          'Viewer',
  operator:        'Operator',
  user:            'User',
  user_with_costs: 'User with Costs',
  developer:       'Developer',
  admin:           'Admin',
  instance_admin:  'Instance Admin',
}

// Inheritance chain — used by resolvePermissions() to expand role.extends
export const BUILT_IN_ROLE_EXTENDS: Partial<Record<BuiltInRoleName, BuiltInRoleName>> = {
  operator:        'viewer',
  user:            'operator',
  user_with_costs: 'user',
  developer:       'user_with_costs',
  admin:           'developer',
  instance_admin:  'admin',
}
