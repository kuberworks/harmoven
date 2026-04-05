-- CreateTable
CREATE TABLE "PromptSummary" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "agent_type" TEXT NOT NULL,
    "domain_profile" TEXT NOT NULL,
    "execution_context" JSONB NOT NULL,
    "estimated_tokens_in" INTEGER,
    "estimated_tokens_out" INTEGER,
    "upstream_handoff_hash" TEXT,
    "serialization_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptSummary_run_id_idx" ON "PromptSummary"("run_id");

-- CreateIndex
CREATE INDEX "PromptSummary_node_id_idx" ON "PromptSummary"("node_id");

-- CreateIndex
CREATE UNIQUE INDEX "PromptSummary_run_id_node_id_key" ON "PromptSummary"("run_id", "node_id");

-- AddForeignKey
ALTER TABLE "PromptSummary" ADD CONSTRAINT "PromptSummary_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
