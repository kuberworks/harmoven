-- Amendment 89 — EvalAgent: add EvalResult table

-- CreateTable
CREATE TABLE "EvalResult" (
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

-- CreateIndex
CREATE INDEX "EvalResult_run_id_idx" ON "EvalResult"("run_id");

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
