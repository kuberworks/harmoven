-- Rollback Amendment 64: remove last_completed_node_at from Run.
-- This was added to track the timestamp of the most recently completed node
-- for context injection filtering in computeAgentContext().

ALTER TABLE "Run" DROP COLUMN IF EXISTS "last_completed_node_at";
