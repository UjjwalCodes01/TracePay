-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PayoutBatch" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "rightsCheck" JSONB,
ADD COLUMN     "snapshotHash" TEXT,
ADD COLUMN     "termsSnapshot" JSONB;

-- AlterTable
ALTER TABLE "SettlementRun" ADD COLUMN     "failureReason" TEXT;
