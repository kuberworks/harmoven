-- Migration: add_system_settings
-- Adds SystemSetting table for instance-wide key/value configuration.
-- Writable via PATCH /api/admin/security (instance_admin only).
-- Readable via GET /api/instance/policy (public, non-sensitive values only).

CREATE TABLE "SystemSetting" (
    "key"        TEXT         NOT NULL,
    "value"      TEXT         NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);
