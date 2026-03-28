-- down.sql — reverse migration for add_llm_provider_key_and_project_archive_am40
-- Convention: Amendment 84 — all migrations must have a down.sql.

DROP INDEX IF EXISTS "LlmProviderKey_provider_active_key";
DROP INDEX IF EXISTS "LlmProviderKey_provider_idx";
DROP TABLE IF EXISTS "LlmProviderKey";

ALTER TABLE "Project" DROP COLUMN IF EXISTS "archived_at";
