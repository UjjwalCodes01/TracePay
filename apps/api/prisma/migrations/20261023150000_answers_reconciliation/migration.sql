-- Reconciliation for answer-credit top-ups and royalty payout batches; per-refund top-up debits.

-- AlterTable
ALTER TABLE "CreditEntry" ADD COLUMN     "refundId" TEXT;

-- AlterTable
ALTER TABLE "CreditTopUp" ADD COLUMN     "checkCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "checkLockedUntil" TIMESTAMP(3),
ADD COLUMN     "creditedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RoyaltyPayout" ADD COLUMN     "nextPollAt" TIMESTAMP(3),
ADD COLUMN     "pollCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pollLockedUntil" TIMESTAMP(3),
ADD COLUMN     "sendingSince" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "CreditEntry_refundId_key" ON "CreditEntry"("refundId");

-- CreateIndex
CREATE INDEX "CreditTopUp_nextCheckAt_idx" ON "CreditTopUp"("nextCheckAt");

-- CreateIndex
CREATE INDEX "RoyaltyPayout_nextPollAt_idx" ON "RoyaltyPayout"("nextPollAt");


-- Backfill: what each existing top-up actually credited (the ledger is the truth).
UPDATE "CreditTopUp" t SET "creditedCents" = COALESCE((SELECT SUM(e."amountCents") FROM "CreditEntry" e WHERE e."topUpId" = t.id AND e.kind = 'top_up'), 0)
WHERE t.status IN ('captured', 'refunded');
UPDATE "CreditTopUp" SET "refundedCents" = "creditedCents" WHERE status = 'refunded';
-- Unfinished top-ups get one look from reconciliation.
UPDATE "CreditTopUp" SET "nextCheckAt" = CURRENT_TIMESTAMP WHERE status = 'pending_payment' AND "orderId" IS NOT NULL;
-- Royalty batches PayPal accepted but that aren't final get polled.
UPDATE "RoyaltyPayout" SET "nextPollAt" = CURRENT_TIMESTAMP WHERE "paypalBatchId" IS NOT NULL AND status NOT IN ('SUCCESS', 'DENIED', 'CANCELED');

ALTER TABLE "CreditTopUp" ADD CONSTRAINT "CreditTopUp_refunds_within_credit" CHECK ("refundedCents" >= 0 AND "refundedCents" <= "creditedCents");
