-- PayPal's own fee on a credit top-up, from its capture.

-- AlterTable
ALTER TABLE "CreditTopUp" ADD COLUMN     "paypalFeeCents" INTEGER;
