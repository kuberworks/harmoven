-- prisma/migrations/20260329150000_rgpd_run_data_expires_at/migration.sql
-- RGPD Art.5 §1 e) — Add data retention TTL field to Run table.
-- The data_expires_at column defines when the run's personal data content
-- (task_input, user_injections, Node.partial_output, Node.handoff_out)
-- should be purged by the daily maintenance job.
-- Default: 90 days from run creation (set by application code, not DB).

ALTER TABLE "Run" ADD COLUMN "data_expires_at" TIMESTAMP(3);

-- Back-fill existing rows: mark them as expiring 90 days from now so that
-- the maintenance job has a clean TTL to work with going forward.
UPDATE "Run" SET "data_expires_at" = NOW() + INTERVAL '90 days'
WHERE "data_expires_at" IS NULL;

CREATE INDEX "Run_data_expires_at_idx" ON "Run"("data_expires_at");
