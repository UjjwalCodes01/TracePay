-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LicenseStatus" ADD VALUE 'requested';
ALTER TYPE "LicenseStatus" ADD VALUE 'offered';
ALTER TYPE "LicenseStatus" ADD VALUE 'declined';
ALTER TYPE "LicenseStatus" ADD VALUE 'withdrawn';

-- AlterEnum
ALTER TYPE "TermsOrigin" ADD VALUE 'rules_draft';

-- AlterTable
ALTER TABLE "LicenseGrant" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedById" TEXT,
ADD COLUMN     "closedReason" TEXT,
ADD COLUMN     "offeredAt" TIMESTAMP(3),
ADD COLUMN     "requestMessage" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "terms" DROP NOT NULL,
ALTER COLUMN "termsHash" DROP NOT NULL;
