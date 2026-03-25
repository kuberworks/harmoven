-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER', 'VIEWER');

-- CreateEnum
CREATE TYPE "UiLevel" AS ENUM ('GUIDED', 'STANDARD', 'ADVANCED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SUSPENDED', 'PAUSED');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('PENDING', 'RUNNING', 'BLOCKED', 'FAILED', 'ESCALATED', 'SKIPPED', 'COMPLETED', 'DEADLOCKED', 'INTERRUPTED');

-- CreateEnum
CREATE TYPE "HumanGateStatus" AS ENUM ('OPEN', 'RESOLVED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('CRON', 'FILE_WATCHER', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "CredentialType" AS ENUM ('HTTP_BEARER', 'HTTP_BASIC', 'HEADER', 'QUERY_PARAM', 'OAUTH2');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "banned" BOOLEAN,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "ui_score" INTEGER NOT NULL DEFAULT 0,
    "ui_level" TEXT NOT NULL DEFAULT 'GUIDED',
    "expert_mode" BOOLEAN NOT NULL DEFAULT false,
    "preferences" TEXT NOT NULL DEFAULT '{}',
    "ui_locale" TEXT,
    "transparency_language" TEXT,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twoFactor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "twoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "domain_profile" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "confidentiality" TEXT NOT NULL DEFAULT 'MEDIUM',
    "regulatory_ctx" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "config_git_hash" TEXT,
    "config_git_at" TIMESTAMP(3),

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by" TEXT,
    "trigger_id" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "suspended_reason" TEXT,
    "domain_profile" TEXT NOT NULL,
    "task_input" JSONB NOT NULL,
    "dag" JSONB NOT NULL,
    "run_config" JSONB NOT NULL,
    "transparency_mode" BOOLEAN NOT NULL DEFAULT false,
    "user_injections" JSONB NOT NULL DEFAULT '[]',
    "budget_usd" DECIMAL(10,4),
    "budget_tokens" INTEGER,
    "cost_actual_usd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "tokens_actual" INTEGER NOT NULL DEFAULT 0,
    "confidentiality" TEXT,
    "regulatory_contexts" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "paused_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "estimated_hours_saved" DOUBLE PRECISION,
    "user_rating" INTEGER,
    "business_value_note" TEXT,
    "task_input_chars" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "agent_type" TEXT NOT NULL,
    "status" "NodeStatus" NOT NULL DEFAULT 'PENDING',
    "llm_profile_id" TEXT,
    "llm_assigned_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "interrupted_at" TIMESTAMP(3),
    "interrupted_by" TEXT,
    "last_heartbeat" TIMESTAMP(3),
    "retries" INTEGER NOT NULL DEFAULT 0,
    "handoff_in" JSONB,
    "handoff_out" JSONB,
    "partial_output" TEXT,
    "partial_updated_at" TIMESTAMP(3),
    "cost_usd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "source_agent" TEXT NOT NULL,
    "source_node_id" TEXT,
    "target_agent" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanGate" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" "HumanGateStatus" NOT NULL DEFAULT 'OPEN',
    "decision" TEXT,
    "decided_by" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeout_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "HumanGate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_id" TEXT,
    "node_id" TEXT,
    "actor" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "payload" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trigger" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "type" "TriggerType" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "template_id" TEXT,
    "task_overrides" JSONB NOT NULL DEFAULT '{}',
    "supervision" TEXT NOT NULL DEFAULT 'auto_deliver_if_approved',
    "notify" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_fired_at" TIMESTAMP(3),
    "run_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmProfile" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model_string" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "context_window" INTEGER NOT NULL,
    "cost_per_1m_input_tokens" DECIMAL(10,4) NOT NULL,
    "cost_per_1m_output_tokens" DECIMAL(10,4) NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "trust_tier" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "task_type_affinity" TEXT[],
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "LlmProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpSkill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source_url" TEXT,
    "source_type" TEXT NOT NULL,
    "version" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "scan_status" TEXT NOT NULL DEFAULT 'pending',
    "scan_report" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryResource" (
    "id" TEXT NOT NULL,
    "project_id" TEXT,
    "namespace" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "l0_abstract" TEXT NOT NULL,
    "l1_overview" TEXT,
    "l2_content" TEXT,
    "content_hash" TEXT NOT NULL,
    "last_written" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_accessed" TIMESTAMP(3),
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "MemoryResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRole" (
    "id" TEXT NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "extends" TEXT,
    "permissions" TEXT[],
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "ProjectRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "ProjectApiKey" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "ProjectApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCredential" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value_enc" TEXT NOT NULL,
    "type" "CredentialType" NOT NULL,
    "inject_as" TEXT NOT NULL,
    "inject_fmt" TEXT NOT NULL,
    "host_pattern" TEXT NOT NULL,
    "path_pattern" TEXT,
    "tool_scope" TEXT[],
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),

    CONSTRAINT "ProjectCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token_url" TEXT NOT NULL,
    "scope" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "trigger_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "preference" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "confidence" DECIMAL(4,2) NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" TIMESTAMP(3),

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstalledPack" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "user_id" TEXT NOT NULL,
    "pack_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "update_policy" TEXT NOT NULL DEFAULT 'notify',
    "pinned_version" TEXT,
    "local_overrides" JSONB,
    "scope" TEXT NOT NULL DEFAULT 'workspace',
    "project_ids" TEXT[],
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "installed_by" TEXT NOT NULL,

    CONSTRAINT "InstalledPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceTrustEvent" (
    "id" TEXT NOT NULL,
    "run_id" TEXT,
    "user_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "trust_level" TEXT NOT NULL,
    "reason" TEXT,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceTrustEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitWorktree" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "branch_name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "merged_at" TIMESTAMP(3),
    "cleaned_at" TIMESTAMP(3),

    CONSTRAINT "GitWorktree_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventPayload" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventPayload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunActorStats" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunActorStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalResult" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "criteria" JSONB NOT NULL,
    "feedback" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "twoFactor_userId_key" ON "twoFactor"("userId");

-- CreateIndex
CREATE INDEX "Run_project_id_idx" ON "Run"("project_id");

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "Run_created_by_idx" ON "Run"("created_by");

-- CreateIndex
CREATE INDEX "Node_run_id_idx" ON "Node"("run_id");

-- CreateIndex
CREATE INDEX "Node_status_idx" ON "Node"("status");

-- CreateIndex
CREATE INDEX "Node_last_heartbeat_idx" ON "Node"("last_heartbeat");

-- CreateIndex
CREATE INDEX "Handoff_run_id_idx" ON "Handoff"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "Handoff_run_id_sequence_number_key" ON "Handoff"("run_id", "sequence_number");

-- CreateIndex
CREATE INDEX "HumanGate_run_id_idx" ON "HumanGate"("run_id");

-- CreateIndex
CREATE INDEX "AuditLog_run_id_idx" ON "AuditLog"("run_id");

-- CreateIndex
CREATE INDEX "AuditLog_actor_idx" ON "AuditLog"("actor");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryResource_uri_key" ON "MemoryResource"("uri");

-- CreateIndex
CREATE INDEX "MemoryResource_project_id_namespace_idx" ON "MemoryResource"("project_id", "namespace");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRole_project_id_name_key" ON "ProjectRole"("project_id", "name");

-- CreateIndex
CREATE INDEX "ProjectMember_user_id_idx" ON "ProjectMember"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectApiKey_key_hash_key" ON "ProjectApiKey"("key_hash");

-- CreateIndex
CREATE INDEX "ProjectApiKey_project_id_idx" ON "ProjectApiKey"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCredential_project_id_name_key" ON "ProjectCredential"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthToken_credential_id_key" ON "OAuthToken"("credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_delivery_id_key" ON "WebhookDelivery"("delivery_id");

-- CreateIndex
CREATE INDEX "WebhookDelivery_received_at_idx" ON "WebhookDelivery"("received_at");

-- CreateIndex
CREATE INDEX "UserPreference_user_id_project_id_idx" ON "UserPreference"("user_id", "project_id");

-- CreateIndex
CREATE INDEX "InstalledPack_user_id_idx" ON "InstalledPack"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledPack_user_id_pack_id_key" ON "InstalledPack"("user_id", "pack_id");

-- CreateIndex
CREATE INDEX "SourceTrustEvent_run_id_idx" ON "SourceTrustEvent"("run_id");

-- CreateIndex
CREATE INDEX "SourceTrustEvent_trust_level_idx" ON "SourceTrustEvent"("trust_level");

-- CreateIndex
CREATE INDEX "GitWorktree_run_id_idx" ON "GitWorktree"("run_id");

-- CreateIndex
CREATE INDEX "GitWorktree_project_id_status_idx" ON "GitWorktree"("project_id", "status");

-- CreateIndex
CREATE INDEX "EventPayload_project_id_created_at_idx" ON "EventPayload"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "RunActorStats_run_id_key" ON "RunActorStats"("run_id");

-- CreateIndex
CREATE INDEX "EvalResult_run_id_idx" ON "EvalResult"("run_id");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanGate" ADD CONSTRAINT "HumanGate_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trigger" ADD CONSTRAINT "Trigger_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryResource" ADD CONSTRAINT "MemoryResource_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRole" ADD CONSTRAINT "ProjectRole_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "ProjectRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectApiKey" ADD CONSTRAINT "ProjectApiKey_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectApiKey" ADD CONSTRAINT "ProjectApiKey_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "ProjectRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCredential" ADD CONSTRAINT "ProjectCredential_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "ProjectCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstalledPack" ADD CONSTRAINT "InstalledPack_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitWorktree" ADD CONSTRAINT "GitWorktree_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunActorStats" ADD CONSTRAINT "RunActorStats_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalResult" ADD CONSTRAINT "EvalResult_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AuditLog immutability (PostgreSQL rules)
-- Prevents any UPDATE or DELETE on AuditLog rows at the DB level.
-- These rules run INSTEAD OF the operation and do nothing, effectively blocking it.

CREATE OR REPLACE RULE audit_no_update AS ON UPDATE TO "AuditLog" DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_no_delete AS ON DELETE TO "AuditLog" DO INSTEAD NOTHING;

-- Note: Node.last_heartbeat uses a plain index managed by Prisma ("Node_last_heartbeat_idx").
-- A partial WHERE status='RUNNING' index can be added as a future optimization
-- once Prisma supports @@index([...], where: ...) natively (tracked Prisma issue #13978).
