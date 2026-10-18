-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "tenantId" TEXT;

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_seq_idx" ON "AuditEvent"("tenantId", "seq");
