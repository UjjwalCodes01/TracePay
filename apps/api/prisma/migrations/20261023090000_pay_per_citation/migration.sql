-- Pay-per-citation: prepaid credits (PayPal top-ups), answers, per-citation credits, royalty payouts.

-- CreateEnum
CREATE TYPE "TopUpStatus" AS ENUM ('pending_payment', 'captured', 'payment_failed', 'refunded');

-- CreateEnum
CREATE TYPE "AnswerStatus" AS ENUM ('answering', 'answered', 'not_covered', 'failed');

-- CreateEnum
CREATE TYPE "CreditStatus" AS ENUM ('accrued', 'in_payout', 'paid');

-- CreateTable
CREATE TABLE "CreditAccount" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "reservedCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "topUpId" TEXT,
    "answerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTopUp" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "TopUpStatus" NOT NULL DEFAULT 'pending_payment',
    "orderId" TEXT,
    "captureId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "CreditTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Answer" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "maxPriceCents" INTEGER NOT NULL,
    "reservedCents" INTEGER NOT NULL DEFAULT 0,
    "status" "AnswerStatus" NOT NULL DEFAULT 'answering',
    "content" JSONB,
    "model" TEXT,
    "fromFixture" BOOLEAN NOT NULL DEFAULT false,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "chargedCents" INTEGER NOT NULL DEFAULT 0,
    "excluded" JSONB NOT NULL DEFAULT '[]',
    "receipt" JSONB,
    "signature" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitationCredit" (
    "id" TEXT NOT NULL,
    "answerId" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "contributorId" TEXT NOT NULL,
    "assetVersionId" TEXT NOT NULL,
    "assetTitle" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "termsHash" TEXT,
    "centsPerCitation" INTEGER NOT NULL,
    "citations" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "CreditStatus" NOT NULL DEFAULT 'accrued',
    "payoutItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitationCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoyaltyPayout" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "senderBatchId" TEXT NOT NULL,
    "paypalBatchId" TEXT,
    "status" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "RoyaltyPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoyaltyPayoutItem" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "senderItemId" TEXT NOT NULL,
    "contributorId" TEXT NOT NULL,
    "receiver" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTING',
    "paypalItemId" TEXT,
    "transactionId" TEXT,
    "errorName" TEXT,

    CONSTRAINT "RoyaltyPayoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditAccount_ownerId_key" ON "CreditAccount"("ownerId");

-- CreateIndex
CREATE INDEX "CreditEntry_accountId_createdAt_idx" ON "CreditEntry"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTopUp_orderId_key" ON "CreditTopUp"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTopUp_captureId_key" ON "CreditTopUp"("captureId");

-- CreateIndex
CREATE INDEX "Answer_accountId_createdAt_idx" ON "Answer"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "Answer_libraryId_createdAt_idx" ON "Answer"("libraryId", "createdAt");

-- CreateIndex
CREATE INDEX "Answer_status_createdAt_idx" ON "Answer"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CitationCredit_libraryId_status_idx" ON "CitationCredit"("libraryId", "status");

-- CreateIndex
CREATE INDEX "CitationCredit_contributorId_createdAt_idx" ON "CitationCredit"("contributorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoyaltyPayout_senderBatchId_key" ON "RoyaltyPayout"("senderBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "RoyaltyPayout_paypalBatchId_key" ON "RoyaltyPayout"("paypalBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "RoyaltyPayoutItem_senderItemId_key" ON "RoyaltyPayoutItem"("senderItemId");

-- AddForeignKey
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTopUp" ADD CONSTRAINT "CreditTopUp_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationCredit" ADD CONSTRAINT "CitationCredit_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "Answer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationCredit" ADD CONSTRAINT "CitationCredit_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitationCredit" ADD CONSTRAINT "CitationCredit_payoutItemId_fkey" FOREIGN KEY ("payoutItemId") REFERENCES "RoyaltyPayoutItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyPayout" ADD CONSTRAINT "RoyaltyPayout_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyPayoutItem" ADD CONSTRAINT "RoyaltyPayoutItem_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "RoyaltyPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Money invariants the database itself enforces.
ALTER TABLE "CreditAccount" ADD CONSTRAINT "CreditAccount_reserved_nonneg" CHECK ("reservedCents" >= 0);
ALTER TABLE "CreditTopUp" ADD CONSTRAINT "CreditTopUp_amount_pos" CHECK ("amountCents" > 0);
ALTER TABLE "CitationCredit" ADD CONSTRAINT "CitationCredit_amounts" CHECK ("citations" > 0 AND "centsPerCitation" >= 0 AND "amountCents" = "citations" * "centsPerCitation");
ALTER TABLE "Answer" ADD CONSTRAINT "Answer_within_mandate" CHECK ("chargedCents" >= 0 AND "chargedCents" <= "maxPriceCents");
