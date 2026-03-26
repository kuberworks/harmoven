-- down.sql — reverse of 20260326140000_seed_builtin_roles_am78
-- Amendment 78 — built-in ProjectRole seed rollback
--
-- WARNING: Only safe on a freshly seeded database.
-- On production: archive rather than delete — role_id FKs in ProjectMember
-- will break if rows referenced by members are removed.

DELETE FROM "ProjectRole" WHERE is_builtin = TRUE;
