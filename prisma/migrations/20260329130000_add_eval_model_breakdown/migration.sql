-- prisma/migrations/20260329130000_add_eval_model_breakdown/migration.sql
-- Amendment 4.4: add model_breakdown column to EvalResult for parallel model validation

ALTER TABLE "EvalResult" ADD COLUMN "model_breakdown" JSONB;
