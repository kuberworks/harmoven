-- Migration: marketplace_v2
-- Adds tables and columns for Marketplace v2:
--   A) New tables: GitUrlWhitelistEntry, MarketplaceRegistry, GitProviderToken
--   B) McpSkill additions: capability_type, pack_id (unique), author, tags,
--      registry_id, upload_sha256, source_ref, installed_sha256,
--      last_update_check_at, pending_update
--   C) GitHubImportPreview additions: created_by, file_hashes, context

-- ─── A. New tables ────────────────────────────────────────────────────────────

CREATE TABLE "GitUrlWhitelistEntry" (
    "id"          TEXT         NOT NULL,
    "label"       TEXT         NOT NULL,
    "pattern"     TEXT         NOT NULL,
    "description" TEXT,
    "is_builtin"  BOOLEAN      NOT NULL DEFAULT false,
    "enabled"     BOOLEAN      NOT NULL DEFAULT true,
    "created_by"  TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitUrlWhitelistEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitUrlWhitelistEntry_pattern_key" ON "GitUrlWhitelistEntry"("pattern");

CREATE TABLE "MarketplaceRegistry" (
    "id"                TEXT         NOT NULL,
    "label"             TEXT         NOT NULL,
    "feed_url"          TEXT         NOT NULL,
    "auth_header_enc"   TEXT,
    "is_builtin"        BOOLEAN      NOT NULL DEFAULT false,
    "enabled"           BOOLEAN      NOT NULL DEFAULT true,
    "last_fetched_at"   TIMESTAMP(3),
    "last_fetch_status" TEXT,
    "created_by"        TEXT         NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceRegistry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketplaceRegistry_feed_url_key" ON "MarketplaceRegistry"("feed_url");

CREATE TABLE "GitProviderToken" (
    "id"           TEXT         NOT NULL,
    "label"        TEXT         NOT NULL,
    "host_pattern" TEXT         NOT NULL,
    "token_enc"    TEXT         NOT NULL,
    "enabled"      BOOLEAN      NOT NULL DEFAULT true,
    "expires_at"   TIMESTAMP(3),
    "created_by"   TEXT         NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitProviderToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitProviderToken_host_pattern_key" ON "GitProviderToken"("host_pattern");

-- ─── B. McpSkill additions ────────────────────────────────────────────────────

ALTER TABLE "McpSkill"
    ADD COLUMN "capability_type"      TEXT,
    ADD COLUMN "pack_id"              TEXT,
    ADD COLUMN "author"               TEXT,
    ADD COLUMN "tags"                 TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "registry_id"          TEXT,
    ADD COLUMN "upload_sha256"        TEXT,
    ADD COLUMN "source_ref"           TEXT,
    ADD COLUMN "installed_sha256"     TEXT,
    ADD COLUMN "last_update_check_at" TIMESTAMP(3),
    ADD COLUMN "pending_update"       JSONB;

-- pack_id unique constraint (nullable — UNIQUE allows multiple NULLs in PG)
CREATE UNIQUE INDEX "McpSkill_pack_id_key" ON "McpSkill"("pack_id")
    WHERE "pack_id" IS NOT NULL;

CREATE INDEX "McpSkill_source_type_idx" ON "McpSkill"("source_type");
CREATE INDEX "McpSkill_last_update_check_at_idx" ON "McpSkill"("last_update_check_at");

-- ─── C. GitHubImportPreview additions ────────────────────────────────────────

ALTER TABLE "GitHubImportPreview"
    ADD COLUMN "created_by"  TEXT,
    ADD COLUMN "file_hashes" JSONB,
    ADD COLUMN "context"     TEXT;

-- ─── D. Seed built-in whitelist entries ──────────────────────────────────────

INSERT INTO "GitUrlWhitelistEntry"
    ("id", "label", "pattern", "is_builtin", "enabled", "created_by", "created_at", "updated_at")
VALUES
    (gen_random_uuid()::text, 'GitHub',               'github.com',                  true, true, 'system', NOW(), NOW()),
    (gen_random_uuid()::text, 'GitHub Raw',            'raw.githubusercontent.com',   true, true, 'system', NOW(), NOW()),
    (gen_random_uuid()::text, 'GitHub API',            'api.github.com',              true, true, 'system', NOW(), NOW()),
    (gen_random_uuid()::text, 'GitLab',                'gitlab.com',                  true, true, 'system', NOW(), NOW()),
    (gen_random_uuid()::text, 'Bitbucket',             'bitbucket.org',               true, true, 'system', NOW(), NOW())
ON CONFLICT ("pattern") DO NOTHING;

-- ─── E. Seed official registry ────────────────────────────────────────────────

INSERT INTO "MarketplaceRegistry"
    ("id", "label", "feed_url", "is_builtin", "enabled", "created_by", "created_at", "updated_at")
VALUES
    (gen_random_uuid()::text, 'Harmoven Official', 'https://marketplace.harmoven.com/index.json',
     true, true, 'system', NOW(), NOW())
ON CONFLICT ("feed_url") DO NOTHING;
