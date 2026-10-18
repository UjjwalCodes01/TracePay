-- CreateEnum
CREATE TYPE "Role" AS ENUM ('publisher', 'contributor', 'buyer', 'admin');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('dataset', 'research_notes', 'expert_brief', 'api_feed');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('draft', 'approved', 'revoked', 'superseded');

-- CreateEnum
CREATE TYPE "TermsOrigin" AS ENUM ('manual', 'ai_draft');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('running', 'awaiting_approval', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AgentStepKind" AS ENUM ('plan', 'tool_call', 'tool_result', 'approval_request', 'message', 'error');

-- CreateEnum
CREATE TYPE "BuildStatus" AS ENUM ('preflight_blocked', 'preflight_passed', 'generating', 'generated', 'generation_failed');

-- CreateEnum
CREATE TYPE "SourceEventType" AS ENUM ('retrieved', 'cited');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('draft', 'listed', 'withdrawn');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('pending_payment', 'captured', 'payment_failed', 'refunded', 'exception');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('calculated', 'approved', 'payout_submitted', 'completed', 'exception');

-- CreateEnum
CREATE TYPE "SettlementLineKind" AS ENUM ('contributor', 'publisher_residual');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "paypalEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetVersion" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceChunk" (
    "id" TEXT NOT NULL,
    "assetVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "SourceChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicenseGrant" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "licenseeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'draft',
    "terms" JSONB NOT NULL,
    "termsHash" TEXT NOT NULL,
    "origin" "TermsOrigin" NOT NULL DEFAULT 'manual',
    "aiExtraction" JSONB,
    "sourceText" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LicenseGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'running',
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "AgentStepKind" NOT NULL,
    "tool" TEXT,
    "input" JSONB,
    "output" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildJob" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "intent" JSONB NOT NULL,
    "asOf" TEXT NOT NULL,
    "status" "BuildStatus" NOT NULL,
    "preflight" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildSource" (
    "id" TEXT NOT NULL,
    "buildJobId" TEXT NOT NULL,
    "assetVersionId" TEXT NOT NULL,
    "licenseGrantId" TEXT,
    "termsSnapshot" JSONB,
    "payeeEmail" TEXT,

    CONSTRAINT "BuildSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEvent" (
    "id" TEXT NOT NULL,
    "buildJobId" TEXT NOT NULL,
    "assetVersionId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "eventType" "SourceEventType" NOT NULL,
    "handle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "buildJobId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "ArtifactStatus" NOT NULL DEFAULT 'draft',
    "citationReport" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "fromFixture" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtifactCitation" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "assetVersionId" TEXT NOT NULL,

    CONSTRAINT "ArtifactCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "buyerId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "SaleStatus" NOT NULL DEFAULT 'pending_payment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayPalPayment" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderStatus" TEXT NOT NULL,
    "captureId" TEXT,
    "captureStatus" TEXT,
    "capturedCents" INTEGER,
    "paypalFeeCents" INTEGER,
    "payerEmail" TEXT,
    "rawCapture" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayPalPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "verified" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementRun" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "contributorTotalCents" INTEGER NOT NULL,
    "publisherResidualCents" INTEGER NOT NULL,
    "roundingRule" TEXT NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'calculated',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" "SettlementLineKind" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "payeeEmail" TEXT,
    "licenseGrantId" TEXT,
    "assetVersionId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "formula" TEXT NOT NULL,
    "payable" BOOLEAN NOT NULL,
    "note" TEXT,

    CONSTRAINT "SettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutBatch" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "senderBatchId" TEXT NOT NULL,
    "paypalBatchId" TEXT,
    "status" TEXT NOT NULL,
    "lastResponse" JSONB,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "settlementLineId" TEXT NOT NULL,
    "senderItemId" TEXT NOT NULL,
    "paypalItemId" TEXT,
    "transactionId" TEXT,
    "receiver" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "errorName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "seq" SERIAL NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "artifactId" TEXT,
    "previousHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_assetId_version_key" ON "AssetVersion"("assetId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SourceChunk_assetVersionId_ordinal_key" ON "SourceChunk"("assetVersionId", "ordinal");

-- CreateIndex
CREATE INDEX "LicenseGrant_assetId_licenseeId_status_idx" ON "LicenseGrant"("assetId", "licenseeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LicenseGrant_assetId_licenseeId_version_key" ON "LicenseGrant"("assetId", "licenseeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_runId_ordinal_key" ON "AgentStep"("runId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "BuildSource_buildJobId_assetVersionId_key" ON "BuildSource"("buildJobId", "assetVersionId");

-- CreateIndex
CREATE INDEX "SourceEvent_buildJobId_eventType_idx" ON "SourceEvent"("buildJobId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_buildJobId_key" ON "Artifact"("buildJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactCitation_artifactId_sectionKey_chunkId_key" ON "ArtifactCitation"("artifactId", "sectionKey", "chunkId");

-- CreateIndex
CREATE UNIQUE INDEX "PayPalPayment_saleId_key" ON "PayPalPayment"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "PayPalPayment_orderId_key" ON "PayPalPayment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PayPalPayment_captureId_key" ON "PayPalPayment"("captureId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementRun_saleId_key" ON "SettlementRun"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutBatch_runId_key" ON "PayoutBatch"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutBatch_senderBatchId_key" ON "PayoutBatch"("senderBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutBatch_paypalBatchId_key" ON "PayoutBatch"("paypalBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutItem_settlementLineId_key" ON "PayoutItem"("settlementLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutItem_senderItemId_key" ON "PayoutItem"("senderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutItem_paypalItemId_key" ON "PayoutItem"("paypalItemId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_hash_key" ON "AuditEvent"("hash");

-- CreateIndex
CREATE INDEX "AuditEvent_artifactId_idx" ON "AuditEvent"("artifactId");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceChunk" ADD CONSTRAINT "SourceChunk_assetVersionId_fkey" FOREIGN KEY ("assetVersionId") REFERENCES "AssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenseGrant" ADD CONSTRAINT "LicenseGrant_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicenseGrant" ADD CONSTRAINT "LicenseGrant_licenseeId_fkey" FOREIGN KEY ("licenseeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildJob" ADD CONSTRAINT "BuildJob_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildJob" ADD CONSTRAINT "BuildJob_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildSource" ADD CONSTRAINT "BuildSource_buildJobId_fkey" FOREIGN KEY ("buildJobId") REFERENCES "BuildJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildSource" ADD CONSTRAINT "BuildSource_assetVersionId_fkey" FOREIGN KEY ("assetVersionId") REFERENCES "AssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildSource" ADD CONSTRAINT "BuildSource_licenseGrantId_fkey" FOREIGN KEY ("licenseGrantId") REFERENCES "LicenseGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEvent" ADD CONSTRAINT "SourceEvent_buildJobId_fkey" FOREIGN KEY ("buildJobId") REFERENCES "BuildJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEvent" ADD CONSTRAINT "SourceEvent_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "SourceChunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_buildJobId_fkey" FOREIGN KEY ("buildJobId") REFERENCES "BuildJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactCitation" ADD CONSTRAINT "ArtifactCitation_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactCitation" ADD CONSTRAINT "ArtifactCitation_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "SourceChunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayPalPayment" ADD CONSTRAINT "PayPalPayment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRun" ADD CONSTRAINT "SettlementRun_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLine" ADD CONSTRAINT "SettlementLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutBatch" ADD CONSTRAINT "PayoutBatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SettlementRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_settlementLineId_fkey" FOREIGN KEY ("settlementLineId") REFERENCES "SettlementLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
