-- prisma/migrations/20260327100000_conditional_heartbeat_index_t1_2/down.sql
-- Rollback: restore the broad last_heartbeat index and drop the partial one.

DROP INDEX IF EXISTS "Node_last_heartbeat_running_idx";

CREATE INDEX IF NOT EXISTS "Node_last_heartbeat_idx"
  ON "Node" ("last_heartbeat");
