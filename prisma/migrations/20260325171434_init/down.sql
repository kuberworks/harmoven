-- down.sql — reverse of 20260325171434_init migration
-- Drops all Harmoven tables and types in dependency order (FKs first, enums last).
-- Run this file to rollback the initial schema entirely.

-- ─── Foreign Keys / dependent tables → most-dependent first ──────────────────

-- AuditLog immutability rules (PostgreSQL) — drop before table
DROP RULE IF EXISTS audit_no_update ON "AuditLog";
DROP RULE IF EXISTS audit_no_delete ON "AuditLog";

-- Application tables (reverse of FK tree)
DROP TABLE IF EXISTS "EvalResult";
DROP TABLE IF EXISTS "RunActorStats";
DROP TABLE IF EXISTS "EventPayload";
DROP TABLE IF EXISTS "GitWorktree";
DROP TABLE IF EXISTS "SourceTrustEvent";
DROP TABLE IF EXISTS "InstalledPack";
DROP TABLE IF EXISTS "UserPreference";
DROP TABLE IF EXISTS "WebhookDelivery";
DROP TABLE IF EXISTS "OAuthToken";
DROP TABLE IF EXISTS "ProjectCredential";
DROP TABLE IF EXISTS "ProjectApiKey";
DROP TABLE IF EXISTS "ProjectMember";
DROP TABLE IF EXISTS "ProjectRole";
DROP TABLE IF EXISTS "MemoryResource";
DROP TABLE IF EXISTS "LlmProfile";
DROP TABLE IF EXISTS "McpSkill";
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "HumanGate";
DROP TABLE IF EXISTS "Handoff";
DROP TABLE IF EXISTS "Node";
DROP TABLE IF EXISTS "Run";
DROP TABLE IF EXISTS "Trigger";

-- Project (referenced by Run, Trigger, ProjectMember, etc.)
DROP TABLE IF EXISTS "Project";

-- Better Auth plugin tables
DROP TABLE IF EXISTS "twoFactor";

-- Better Auth core tables (CASCADE handles child rows)
DROP TABLE IF EXISTS "account";
DROP TABLE IF EXISTS "session";
DROP TABLE IF EXISTS "verification";

-- User table — last because all other tables reference it
DROP TABLE IF EXISTS "user";

-- ─── Enums ────────────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS "CredentialType";
DROP TYPE IF EXISTS "TriggerType";
DROP TYPE IF EXISTS "HumanGateStatus";
DROP TYPE IF EXISTS "NodeStatus";
DROP TYPE IF EXISTS "RunStatus";
DROP TYPE IF EXISTS "UiLevel";
DROP TYPE IF EXISTS "Role";
DROP TYPE IF EXISTS "WorktreeLayer";
