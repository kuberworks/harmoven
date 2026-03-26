-- Migration: 20260326120000_add_critical_reviewer_am75
-- Amendment 75 / Section 27 — Critical Reviewer
-- Adds: CriticalReviewResult, CriticalFindingIgnore, CriticalFindingFix

CREATE TABLE "CriticalReviewResult" (
    "id"         TEXT         NOT NULL,
    "run_id"     TEXT         NOT NULL,
    "severity"   INTEGER      NOT NULL,
    "verdict"    TEXT         NOT NULL,
    "findings"   JSONB        NOT NULL DEFAULT '[]',
    "suppressed" INTEGER      NOT NULL DEFAULT 0,
    "rationale"  TEXT         NOT NULL,
    "llm_used"   TEXT         NOT NULL,
    "cost_usd"   DECIMAL(10,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriticalReviewResult_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CriticalFindingIgnore" (
    "id"         TEXT         NOT NULL,
    "result_id"  TEXT         NOT NULL,
    "finding_id" TEXT         NOT NULL,
    "finding"    JSONB        NOT NULL,
    "ignored_by" TEXT         NOT NULL,
    "ignored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriticalFindingIgnore_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CriticalFindingFix" (
    "id"         TEXT         NOT NULL,
    "result_id"  TEXT         NOT NULL,
    "finding_id" TEXT         NOT NULL,
    "fix_run_id" TEXT,
    "status"     TEXT         NOT NULL DEFAULT 'pending',
    "cost_usd"   DECIMAL(10,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriticalFindingFix_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "CriticalReviewResult_run_id_idx" ON "CriticalReviewResult"("run_id");

-- FK constraints
ALTER TABLE "CriticalReviewResult"
    ADD CONSTRAINT "CriticalReviewResult_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "Run"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CriticalFindingIgnore"
    ADD CONSTRAINT "CriticalFindingIgnore_result_id_fkey"
    FOREIGN KEY ("result_id") REFERENCES "CriticalReviewResult"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CriticalFindingFix"
    ADD CONSTRAINT "CriticalFindingFix_result_id_fkey"
    FOREIGN KEY ("result_id") REFERENCES "CriticalReviewResult"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutability rules for CriticalFindingIgnore (mirrors AuditLog protection)
CREATE RULE "no_update_critical_finding_ignore" AS
    ON UPDATE TO "CriticalFindingIgnore" DO INSTEAD NOTHING;

CREATE RULE "no_delete_critical_finding_ignore" AS
    ON DELETE TO "CriticalFindingIgnore" DO INSTEAD NOTHING;
