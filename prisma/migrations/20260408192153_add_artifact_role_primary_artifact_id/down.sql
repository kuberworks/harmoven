-- Down: 20260408192153_add_artifact_role_primary_artifact_id
-- Reverses: ADD COLUMN artifact_role on RunArtifact, ADD COLUMN primary_artifact_id on Run

ALTER TABLE "RunArtifact" DROP COLUMN IF EXISTS "artifact_role";
ALTER TABLE "Run" DROP COLUMN IF EXISTS "primary_artifact_id";
