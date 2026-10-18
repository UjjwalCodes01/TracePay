-- DropIndex
DROP INDEX "PayoutBatch_runId_key";

-- AlterTable
ALTER TABLE "PayoutBatch" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PayoutItem" ADD COLUMN     "attempts" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE UNIQUE INDEX "PayoutBatch_runId_attempt_key" ON "PayoutBatch"("runId", "attempt");

