-- A buyer who already owned a report and deliberately bought it again (a hosted demo's shared buyer),
-- and indexes on the foreign keys and filters the dashboards use.

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "repeatPurchase" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "AgentRun_publisherId_kind_status_idx" ON "AgentRun"("publisherId", "kind", "status");

-- CreateIndex
CREATE INDEX "Asset_ownerId_idx" ON "Asset"("ownerId");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_seq_idx" ON "AuditEvent"("eventType", "seq");

-- CreateIndex
CREATE INDEX "BuildJob_publisherId_status_idx" ON "BuildJob"("publisherId", "status");

-- CreateIndex
CREATE INDEX "BuildSource_assetVersionId_idx" ON "BuildSource"("assetVersionId");

-- CreateIndex
CREATE INDEX "LicenseGrant_licenseeId_status_idx" ON "LicenseGrant"("licenseeId", "status");

-- CreateIndex
CREATE INDEX "PayoutItem_batchId_idx" ON "PayoutItem"("batchId");

-- CreateIndex
CREATE INDEX "Sale_artifactId_buyerId_status_idx" ON "Sale"("artifactId", "buyerId", "status");

-- CreateIndex
CREATE INDEX "Sale_buyerId_status_idx" ON "Sale"("buyerId", "status");

-- CreateIndex
CREATE INDEX "SettlementLine_runId_idx" ON "SettlementLine"("runId");

