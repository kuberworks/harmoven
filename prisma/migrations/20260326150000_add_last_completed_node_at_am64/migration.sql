-- Amendment 64: add last_completed_node_at to Run for context injection filtering.
-- This field tracks the timestamp of the most recently completed node, used by
-- computeAgentContext() to include only injections added after that point.

ALTER TABLE "Run" ADD COLUMN "last_completed_node_at" TIMESTAMP(3);
