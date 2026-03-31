-- CreateTable
CREATE TABLE "GitHubImportPreview" (
    "id"             TEXT NOT NULL,
    "actor"          TEXT NOT NULL,
    "source_url"     TEXT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "scaffold"       JSONB NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubImportPreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitHubImportPreview_actor_idx" ON "GitHubImportPreview"("actor");

-- CreateIndex
CREATE INDEX "GitHubImportPreview_expires_at_idx" ON "GitHubImportPreview"("expires_at");
