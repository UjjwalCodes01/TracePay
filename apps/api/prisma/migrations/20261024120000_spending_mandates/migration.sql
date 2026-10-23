-- Spending mandates: a buyer lets their shopping assistant pay with saved PayPal, within limits.

-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('pending', 'active', 'revoked');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "mandateId" TEXT;

-- CreateTable
CREATE TABLE "SpendingMandate" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "status" "MandateStatus" NOT NULL DEFAULT 'pending',
    "setupTokenId" TEXT,
    "vaultId" TEXT,
    "paypalCustomerId" TEXT,
    "payerEmail" TEXT,
    "maxPerPurchaseCents" INTEGER NOT NULL,
    "maxTotalCents" INTEGER NOT NULL,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SpendingMandate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpendingMandate_setupTokenId_key" ON "SpendingMandate"("setupTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "SpendingMandate_vaultId_key" ON "SpendingMandate"("vaultId");

-- CreateIndex
CREATE INDEX "SpendingMandate_buyerId_status_idx" ON "SpendingMandate"("buyerId", "status");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "SpendingMandate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendingMandate" ADD CONSTRAINT "SpendingMandate_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Amounts are never negative, and spending never exceeds the mandate.
ALTER TABLE "SpendingMandate" ADD CONSTRAINT "SpendingMandate_amounts_check"
  CHECK ("maxPerPurchaseCents" > 0 AND "maxTotalCents" >= "maxPerPurchaseCents" AND "spentCents" >= 0 AND "spentCents" <= "maxTotalCents");
