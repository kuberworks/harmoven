-- Amendment 46.E rollback — remove Passkey and BetterAuthApiKey tables
-- Convention: Amendment 84 — every migration must have a down.sql

-- ─── API Key ─────────────────────────────────────────────────────────────────
-- Drop FK first, then indexes, then table.

ALTER TABLE "apikey" DROP CONSTRAINT IF EXISTS "apikey_userId_fkey";
DROP INDEX IF EXISTS "apikey_referenceId_idx";
DROP INDEX IF EXISTS "apikey_configId_idx";
DROP INDEX IF EXISTS "apikey_userId_idx";
DROP INDEX IF EXISTS "apikey_key_key";
DROP TABLE IF EXISTS "apikey";

-- ─── Passkey ─────────────────────────────────────────────────────────────────

ALTER TABLE "passkey" DROP CONSTRAINT IF EXISTS "passkey_userId_fkey";
DROP INDEX IF EXISTS "passkey_userId_idx";
DROP INDEX IF EXISTS "passkey_credentialID_key";
DROP TABLE IF EXISTS "passkey";
