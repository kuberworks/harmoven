// lib/auth/permissions.ts
// Fine-grained permission system — Amendment 78.1 / 28.1
// All 27 permissions defined here as the single source of truth.

export type Permission =
  // Run lifecycle
  | 'runs:create'
  | 'runs:read'
  | 'runs:read_costs'
  | 'runs:abort'
  | 'runs:replay'
  | 'runs:inject'
  | 'runs:pause'
  // Human gates
  | 'gates:read'
  | 'gates:approve'
  | 'gates:read_code'
  | 'gates:read_critical'
  // Project management
  | 'project:read'
  | 'project:edit'
  | 'project:members'
  | 'project:credentials'
  // SSE streams
  | 'stream:state'
  | 'stream:gates'
  | 'stream:costs'
  | 'stream:project'
  // Marketplace
  | 'marketplace:install'
  // Admin
  | 'admin:models'
  | 'admin:skills'
  | 'admin:users'
  | 'admin:triggers'
  | 'admin:audit'
  | 'admin:instance'

export const ALL_PERMISSIONS: readonly Permission[] = [
  'runs:create', 'runs:read', 'runs:read_costs', 'runs:abort', 'runs:replay',
  'runs:inject', 'runs:pause',
  'gates:read', 'gates:approve', 'gates:read_code', 'gates:read_critical',
  'project:read', 'project:edit', 'project:members', 'project:credentials',
  'stream:state', 'stream:gates', 'stream:costs', 'stream:project',
  'marketplace:install',
  'admin:models', 'admin:skills', 'admin:users', 'admin:triggers',
  'admin:audit', 'admin:instance',
] as const
