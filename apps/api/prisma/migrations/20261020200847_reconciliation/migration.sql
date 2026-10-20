-- CreateEnum
CREATE TYPE "ReconciliationIssueStatus" AS ENUM ('open', 'resolved');

-- AlterTable
ALTER TABLE "PayPalPayment" ADD COLUMN     "checkCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "checkLockedUntil" TIMESTAMP(3),
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "nextCheckAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PayoutBatch" ADD COLUMN     "nextPollAt" TIMESTAMP(3),
ADD COLUMN     "pollCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pollLockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReconciliationIssue" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "status" "ReconciliationIssueStatus" NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,

    CONSTRAINT "ReconciliationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationIssue_ownerId_status_openedAt_idx" ON "ReconciliationIssue"("ownerId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "ReconciliationIssue_kind_subjectId_status_idx" ON "ReconciliationIssue"("kind", "subjectId", "status");

-- CreateIndex
CREATE INDEX "PayPalPayment_nextCheckAt_idx" ON "PayPalPayment"("nextCheckAt");

-- CreateIndex
CREATE INDEX "PayoutBatch_nextPollAt_idx" ON "PayoutBatch"("nextPollAt");
