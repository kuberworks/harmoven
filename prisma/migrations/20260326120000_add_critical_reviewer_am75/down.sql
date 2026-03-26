-- down.sql — reverse of 20260326120000_add_critical_reviewer_am75
-- Amendment 75 — Critical Reviewer rollback
-- Drop in reverse dependency order: children before parents.

DROP RULE IF EXISTS "no_update_critical_finding_ignore" ON "CriticalFindingIgnore";
DROP RULE IF EXISTS "no_delete_critical_finding_ignore" ON "CriticalFindingIgnore";

DROP TABLE IF EXISTS "CriticalFindingFix";
DROP TABLE IF EXISTS "CriticalFindingIgnore";
DROP TABLE IF EXISTS "CriticalReviewResult";
