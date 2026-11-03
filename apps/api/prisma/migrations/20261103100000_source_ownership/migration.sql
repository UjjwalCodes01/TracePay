-- A contributor's proof that they control the website a source is published on.

-- CreateTable
CREATE TABLE "SourceOwnership" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceOwnership_assetId_key" ON "SourceOwnership"("assetId");

-- AddForeignKey
ALTER TABLE "SourceOwnership" ADD CONSTRAINT "SourceOwnership_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
