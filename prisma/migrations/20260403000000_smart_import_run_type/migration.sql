-- Migration: 20260403000000_smart_import_run_type
-- Add run_type + triggered_by to Run for Smart Import phantom runs (A.4.2).

ALTER TABLE "Run" ADD COLUMN "run_type"     TEXT;
ALTER TABLE "Run" ADD COLUMN "triggered_by" TEXT;

-- Partial index: fast lookup of phantom runs by type
CREATE INDEX "Run_run_type_idx" ON "Run"("run_type") WHERE "run_type" IS NOT NULL;
