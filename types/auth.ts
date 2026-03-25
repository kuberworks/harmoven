// types/auth.ts
// Shared auth types — re-exported for use in API routes, middleware, and frontend.
// Generated from the betterAuth() instance; never hardcode these manually.

export type { Session, AuthUser } from '@/lib/auth'
export type { Permission } from '@/lib/auth/permissions'
export type { Caller, SessionCaller, ApiKeyCaller } from '@/lib/auth/rbac'
export type { BuiltInRoleName } from '@/lib/auth/built-in-roles'
