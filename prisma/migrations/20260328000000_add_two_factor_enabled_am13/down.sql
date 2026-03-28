-- Down migration: remove twoFactorEnabled from user
-- Note: removing this column will break Better Auth twoFactor() plugin.
-- Only roll back if downgrading to a version without the twoFactor plugin.

ALTER TABLE "user"
  DROP COLUMN IF EXISTS "twoFactorEnabled";
