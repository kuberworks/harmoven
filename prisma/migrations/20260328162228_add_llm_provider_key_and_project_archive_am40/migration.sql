-- Migration: add_llm_provider_key_and_project_archive_am40
-- Amendment 40.3 — LlmProviderKey model (credential vault for LLM API keys).
-- Amendment 40.4 — Project.archived_at (soft-delete for DELETE /api/projects/:id).
--
-- LlmProviderKey: stores AES-256-GCM encrypted LLM provider keys.
-- Used when orchestrator.yaml: llm.credential_storage = vault
-- Backward-compatible: env mode (default v1) continues to read from process.env.

-- ─── LlmProviderKey ──────────────────────────────────────────────────────────

CREATE TABLE "LlmProviderKey" (
    "id"           TEXT NOT NULL,
    "provider"     TEXT NOT NULL,
    "label"        TEXT NOT NULL,
    "key_enc"      TEXT NOT NULL,        -- AES-256-GCM: gcm:<iv>:<ciphertext>:<tag>
    "added_by"     TEXT NOT NULL,
    "added_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "active"       BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LlmProviderKey_pkey" PRIMARY KEY ("id")
);

-- Only one active key per provider (enforced like the spec §40.3).
CREATE UNIQUE INDEX "LlmProviderKey_provider_active_key"
    ON "LlmProviderKey"("provider")
    WHERE "active" = true;

CREATE INDEX "LlmProviderKey_provider_idx" ON "LlmProviderKey"("provider");

-- ─── Project.archived_at ─────────────────────────────────────────────────────
-- Soft-delete: NULL = active project; non-NULL = archived.
-- GET /api/projects should filter WHERE archived_at IS NULL (handled in route).
-- Existing rows default to NULL (active).

ALTER TABLE "Project" ADD COLUMN "archived_at" TIMESTAMP(3);
