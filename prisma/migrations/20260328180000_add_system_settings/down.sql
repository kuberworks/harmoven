-- Rollback: add_system_settings
-- Drops the SystemSetting table added in migration.sql.
-- All stored instance-wide settings (e.g. security.mfa_required_for_admin)
-- are permanently lost after this rollback — operators must reconfigure them.

DROP TABLE IF EXISTS "SystemSetting";
