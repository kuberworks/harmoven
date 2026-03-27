-- Amendment 46.E — Add Passkey and BetterAuthApiKey models
-- Enables @better-auth/passkey (FIDO2/WebAuthn) and @better-auth/api-key plugins.
-- Passkey table uses the name 'passkey' (@@map in schema).
-- ApiKey table uses the name 'apikey' (@@map — API_KEY_TABLE_NAME const in plugin).

-- ─── Passkey (FIDO2/WebAuthn) ────────────────────────────────────────────────

CREATE TABLE "passkey" (
    "id"           TEXT NOT NULL,
    "name"         TEXT,
    "publicKey"    TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter"      INTEGER NOT NULL,
    "deviceType"   TEXT NOT NULL,
    "backedUp"     BOOLEAN NOT NULL,
    "transports"   TEXT,
    "aaguid"       TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "passkey_credentialID_key" ON "passkey"("credentialID");
CREATE INDEX "passkey_userId_idx" ON "passkey"("userId");

ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── API Key (@better-auth/api-key) ──────────────────────────────────────────
-- Table name 'apikey' matches API_KEY_TABLE_NAME constant in the plugin.
-- This is the Better Auth user-level API key, distinct from ProjectApiKey
-- (project-scoped RBAC keys in lib/auth/project-api-key.ts).

CREATE TABLE "apikey" (
    "id"                  TEXT NOT NULL,
    "configId"            TEXT NOT NULL DEFAULT 'default',
    "name"                TEXT,
    "start"               TEXT,
    "referenceId"         TEXT NOT NULL,
    "prefix"              TEXT,
    "key"                 TEXT NOT NULL,
    "refillInterval"      INTEGER,
    "refillAmount"        INTEGER,
    "lastRefillAt"        TIMESTAMP(3),
    "enabled"             BOOLEAN NOT NULL DEFAULT TRUE,
    "rateLimitEnabled"    BOOLEAN NOT NULL DEFAULT TRUE,
    "rateLimitTimeWindow" INTEGER,
    "rateLimitMax"        INTEGER,
    "requestCount"        INTEGER NOT NULL DEFAULT 0,
    "remaining"           INTEGER,
    "lastRequest"         TIMESTAMP(3),
    "expiresAt"           TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "permissions"         TEXT,
    "metadata"            JSONB,
    "userId"              TEXT NOT NULL,

    CONSTRAINT "apikey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "apikey_key_key" ON "apikey"("key");
CREATE INDEX "apikey_userId_idx" ON "apikey"("userId");
CREATE INDEX "apikey_configId_idx" ON "apikey"("configId");
CREATE INDEX "apikey_referenceId_idx" ON "apikey"("referenceId");

ALTER TABLE "apikey" ADD CONSTRAINT "apikey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
