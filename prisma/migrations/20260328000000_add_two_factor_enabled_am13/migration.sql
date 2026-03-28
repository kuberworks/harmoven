-- Migration: add twoFactorEnabled to user
-- Amendment 13 (QA fix): Better Auth twoFactor() plugin requires this field
-- directly on the user row. Without it, sign-up raises "Unknown argument twoFactorEnabled".
-- Applied to DB via ALTER TABLE and now tracked as a proper migration.

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
