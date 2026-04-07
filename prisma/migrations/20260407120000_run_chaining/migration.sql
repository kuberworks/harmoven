-- Migration: 20260407120000_run_chaining
-- Adds RunDependency join table to support run chaining (1 child → N parents, max 5).

CREATE TABLE "RunDependency" (
    "child_run_id"  TEXT NOT NULL,
    "parent_run_id" TEXT NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunDependency_pkey" PRIMARY KEY ("child_run_id","parent_run_id")
);

-- Index for querying all children of a given parent run
CREATE INDEX "RunDependency_parent_run_id_idx" ON "RunDependency"("parent_run_id");

-- FK: child_run → Run (cascade delete removes dependency rows when child is deleted)
ALTER TABLE "RunDependency" ADD CONSTRAINT "RunDependency_child_run_id_fkey"
    FOREIGN KEY ("child_run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: parent_run → Run (cascade delete removes dependency rows when parent is deleted)
ALTER TABLE "RunDependency" ADD CONSTRAINT "RunDependency_parent_run_id_fkey"
    FOREIGN KEY ("parent_run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
