-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "primary_artifact_id" TEXT;

-- AlterTable
ALTER TABLE "RunArtifact" ADD COLUMN     "artifact_role" TEXT NOT NULL DEFAULT 'pending_review';
