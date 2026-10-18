-- Backfill AuditEvent."tenantId" for events written before tenant scoping existed.
-- tenantId is not part of the hash chain, so this does not affect chain verification.

UPDATE "AuditEvent" a SET "tenantId" = b."publisherId"
FROM "BuildJob" b
WHERE a."tenantId" IS NULL AND a."entityType" = 'build' AND a."entityId" = b."id";

UPDATE "AuditEvent" a SET "tenantId" = r."publisherId"
FROM "AgentRun" r
WHERE a."tenantId" IS NULL AND a."entityType" = 'agent_run' AND a."entityId" = r."id";

UPDATE "AuditEvent" a SET "tenantId" = b."publisherId"
FROM "Artifact" art JOIN "BuildJob" b ON b."id" = art."buildJobId"
WHERE a."tenantId" IS NULL AND a."entityType" = 'artifact' AND a."entityId" = art."id";

UPDATE "AuditEvent" a SET "tenantId" = b."publisherId"
FROM "Sale" s JOIN "Artifact" art ON art."id" = s."artifactId" JOIN "BuildJob" b ON b."id" = art."buildJobId"
WHERE a."tenantId" IS NULL AND a."entityType" = 'sale' AND a."entityId" = s."id";

UPDATE "AuditEvent" a SET "tenantId" = b."publisherId"
FROM "SettlementRun" sr JOIN "Sale" s ON s."id" = sr."saleId" JOIN "Artifact" art ON art."id" = s."artifactId" JOIN "BuildJob" b ON b."id" = art."buildJobId"
WHERE a."tenantId" IS NULL AND a."entityType" = 'settlement' AND a."entityId" = sr."id";

UPDATE "AuditEvent" a SET "tenantId" = b."publisherId"
FROM "PayoutBatch" pb JOIN "SettlementRun" sr ON sr."id" = pb."runId" JOIN "Sale" s ON s."id" = sr."saleId"
  JOIN "Artifact" art ON art."id" = s."artifactId" JOIN "BuildJob" b ON b."id" = art."buildJobId"
WHERE a."tenantId" IS NULL AND a."entityType" = 'payout_batch' AND a."entityId" = pb."id";
