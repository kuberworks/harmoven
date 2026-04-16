-- Down: 20260407120000_run_chaining
-- Reverses: CreateTable RunDependency + indexes + FKs

ALTER TABLE "RunDependency" DROP CONSTRAINT IF EXISTS "RunDependency_child_run_id_fkey";
ALTER TABLE "RunDependency" DROP CONSTRAINT IF EXISTS "RunDependency_parent_run_id_fkey";
DROP TABLE IF EXISTS "RunDependency";
