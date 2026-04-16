-- Down: 20260408214436_add_llmprofile_modality
-- Reverses: ADD COLUMN modality on LlmProfile

ALTER TABLE "LlmProfile" DROP COLUMN IF EXISTS "modality";
