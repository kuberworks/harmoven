-- prisma/migrations/20260329140000_rgpd_pipeline_template_created_by_nullable/migration.sql
-- RGPD Art.17 — Right to erasure
-- Makes PipelineTemplate.created_by nullable so user account deletion can
-- pseudo-anonymize the creator reference (SetNull) instead of being blocked
-- by a FK constraint or being forced to cascade-delete the template.

ALTER TABLE "PipelineTemplate" ALTER COLUMN "created_by" DROP NOT NULL;
