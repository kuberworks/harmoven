-- Migration: add_pipeline_templates
-- Adds PipelineTemplate + PipelineTemplateVersion models and links Run/Project/User.
-- All timestamps in UTC. Append-only version table; no soft-delete (versions are immutable).

-- ─── PipelineTemplate ────────────────────────────────────────────────────────

CREATE TABLE "PipelineTemplate" (
    "id"               TEXT        NOT NULL,
    "name"             TEXT        NOT NULL,
    "description"      TEXT,
    "project_id"       TEXT,
    "created_by"       TEXT        NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,
    "is_public"        BOOLEAN     NOT NULL DEFAULT false,
    "use_count"        INTEGER     NOT NULL DEFAULT 0,
    "dag"              JSONB       NOT NULL,
    "ai_suggestion"    JSONB,
    "ai_suggested_at"  TIMESTAMP(3),

    CONSTRAINT "PipelineTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PipelineTemplate_created_by_idx"  ON "PipelineTemplate"("created_by");
CREATE INDEX "PipelineTemplate_project_id_idx"  ON "PipelineTemplate"("project_id");

ALTER TABLE "PipelineTemplate"
    ADD CONSTRAINT "PipelineTemplate_created_by_fkey"
        FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PipelineTemplate"
    ADD CONSTRAINT "PipelineTemplate_project_id_fkey"
        FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── PipelineTemplateVersion ─────────────────────────────────────────────────

CREATE TABLE "PipelineTemplateVersion" (
    "id"          TEXT         NOT NULL,
    "template_id" TEXT         NOT NULL,
    "version"     INTEGER      NOT NULL,
    "dag"         JSONB        NOT NULL,
    "change_note" TEXT,
    "source"      TEXT         NOT NULL DEFAULT 'user',
    "created_by"  TEXT         NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PipelineTemplateVersion_template_id_version_key"
    ON "PipelineTemplateVersion"("template_id", "version");

CREATE INDEX "PipelineTemplateVersion_template_id_idx"
    ON "PipelineTemplateVersion"("template_id");

ALTER TABLE "PipelineTemplateVersion"
    ADD CONSTRAINT "PipelineTemplateVersion_template_id_fkey"
        FOREIGN KEY ("template_id") REFERENCES "PipelineTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Run.pipeline_template_id FK (optional) ──────────────────────────────────

ALTER TABLE "Run" ADD COLUMN "pipeline_template_id" TEXT;

CREATE INDEX "Run_pipeline_template_id_idx" ON "Run"("pipeline_template_id");

ALTER TABLE "Run"
    ADD CONSTRAINT "Run_pipeline_template_id_fkey"
        FOREIGN KEY ("pipeline_template_id") REFERENCES "PipelineTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
