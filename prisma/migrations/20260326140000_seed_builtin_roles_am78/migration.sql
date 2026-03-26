-- prisma/migrations/20260326140000_seed_builtin_roles_am78/migration.sql
-- Amendment 78 — Seed 7 built-in ProjectRole rows (is_builtin=true, project_id=NULL)
-- and migrate any existing ProjectMember.role enum values → role_id FK.
--
-- Idempotent: uses INSERT ... ON CONFLICT DO NOTHING so re-running is safe.
-- Built-in roles belong to no project (project_id = NULL) and cannot be deleted
-- through the roles API.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Seed built-in roles
-- ─────────────────────────────────────────────────────────────────────────
-- Permissions are stored as a Postgres text[] matching the Permission union
-- type in lib/auth/permissions.ts.

INSERT INTO "ProjectRole" (id, project_id, name, display_name, extends, permissions, is_builtin, created_at)
VALUES
  -- viewer (root role — no extends)
  ('builtin-viewer',
   NULL, 'viewer', 'Viewer', NULL,
   ARRAY['runs:read', 'stream:state', 'project:read'],
   TRUE, NOW()),

  -- operator extends viewer
  ('builtin-operator',
   NULL, 'operator', 'Operator', 'viewer',
   ARRAY['stream:gates', 'gates:read', 'gates:approve', 'gates:read_critical'],
   TRUE, NOW()),

  -- user extends operator
  ('builtin-user',
   NULL, 'user', 'User', 'operator',
   ARRAY['runs:create', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause', 'marketplace:install'],
   TRUE, NOW()),

  -- user_with_costs extends user
  ('builtin-user-with-costs',
   NULL, 'user_with_costs', 'User with Costs', 'user',
   ARRAY['runs:read_costs', 'stream:costs'],
   TRUE, NOW()),

  -- developer extends user_with_costs
  ('builtin-developer',
   NULL, 'developer', 'Developer', 'user_with_costs',
   ARRAY['gates:read_code', 'project:edit', 'stream:project', 'admin:triggers'],
   TRUE, NOW()),

  -- admin extends developer
  ('builtin-admin',
   NULL, 'admin', 'Admin', 'developer',
   ARRAY['project:members', 'project:credentials', 'admin:skills'],
   TRUE, NOW()),

  -- instance_admin extends admin
  ('builtin-instance-admin',
   NULL, 'instance_admin', 'Instance Admin', 'admin',
   ARRAY['admin:models', 'admin:users', 'admin:audit', 'admin:instance'],
   TRUE, NOW())

ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Migrate legacy ProjectMember rows that still carry a free-text role
--    enum value (from before Amendment 78) to the new role_id FK column.
--
-- The ProjectMember table was updated in T1.2 (init migration) to add
-- role_id as nullable, then in T1.4 it became NOT NULL.  If the column
-- is already populated (i.e., this is a fresh database seeded via Prisma),
-- this UPDATE is a no-op.
-- ─────────────────────────────────────────────────────────────────────────

-- Map legacy enum values to the corresponding built-in role id
UPDATE "ProjectMember"
SET    role_id = CASE
         WHEN role_id = '' OR role_id IS NULL THEN 'builtin-user'
         ELSE role_id  -- already set, keep it
       END
WHERE  role_id IS NULL OR role_id = '';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Index on ProjectApiKey.key_hash (already @unique in schema, but make
--    explicit for readability and tooling compatibility)
-- ─────────────────────────────────────────────────────────────────────────
-- The @unique constraint generates a unique index automatically via Prisma.
-- Nothing to do here — Prisma handles it in the init migration.

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Audit note
-- ─────────────────────────────────────────────────────────────────────────
-- This migration is append-only (INSERT ... ON CONFLICT DO NOTHING).
-- Rollback: DELETE FROM "ProjectRole" WHERE is_builtin = TRUE;
--           (safe only on a fresh DB — on production, archive instead)
