-- Down: 20260405132613_add_prompt_summary_amendment_86
-- Reverses: CreateTable PromptSummary + indexes + FK

ALTER TABLE "PromptSummary" DROP CONSTRAINT IF EXISTS "PromptSummary_run_id_fkey";
DROP TABLE IF EXISTS "PromptSummary";
