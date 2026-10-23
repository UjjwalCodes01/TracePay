-- Private demo worlds: one per visitor of the hosted demo.

-- CreateTable
CREATE TABLE "DemoWorld" (
    "id" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoWorld_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoWorld_lastSeenAt_idx" ON "DemoWorld"("lastSeenAt");

