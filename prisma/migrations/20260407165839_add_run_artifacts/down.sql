-- Down: 20260407165839_add_run_artifacts
-- Reverses: CreateTable RunArtifact + index + FK

ALTER TABLE "RunArtifact" DROP CONSTRAINT IF EXISTS "RunArtifact_run_id_fkey";
DROP TABLE IF EXISTS "RunArtifact";
