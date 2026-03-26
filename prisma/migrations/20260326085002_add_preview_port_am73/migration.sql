-- CreateTable
CREATE TABLE "PreviewPort" (
    "id" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "run_id" TEXT NOT NULL,
    "allocated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewPort_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreviewPort_port_key" ON "PreviewPort"("port");

-- CreateIndex
CREATE UNIQUE INDEX "PreviewPort_run_id_key" ON "PreviewPort"("run_id");

-- CreateIndex
CREATE INDEX "PreviewPort_run_id_idx" ON "PreviewPort"("run_id");
