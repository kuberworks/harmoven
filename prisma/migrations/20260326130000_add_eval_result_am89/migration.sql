-- Amendment 89 — EvalAgent: add EvalResult table with CASCADE FK
--
-- IDEMPOTENT: The init migration was retroactively updated to include EvalResult,
-- so on fresh installs the table already exists when this migration runs.
-- Using IF NOT EXISTS prevents failures on clean installs while remaining
-- harmless on existing DBs where this migration was previously applied.
-- The actual purpose of this migration (vs init) is to upgrade the FK from
-- ON DELETE RESTRICT (init) to ON DELETE CASCADE (required by EvalAgent).

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "EvalResult" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "criteria" JSONB NOT NULL,
    "feedback" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "EvalResult_run_id_idx" ON "EvalResult"("run_id");

-- Upgrade FK to CASCADE (init used RESTRICT; drop-and-recreate is idempotent)
ALTER TABLE "EvalResult" DROP CONSTRAINT IF EXISTS "EvalResult_run_id_fkey";
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
