import type { Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../db';
import { chainHash, GENESIS_HASH, type StoredChainEntry, verifyChain } from './hash-chain';

/** Arbitrary key for the Postgres advisory lock that serialises chain appends. */
const AUDIT_CHAIN_LOCK = 7_401_118;

export interface AuditInput {
  entityType: string;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
  artifactId?: string | null;
  /** Owning publisher. Derived from the entity when omitted. */
  tenantId?: string | null;
}

/** Finds the publisher an entity belongs to, so every event is scoped to a tenant. */
async function resolveTenant(tx: Tx, entityType: string, entityId: string): Promise<string | null> {
  const viaArtifact = { artifact: { select: { buildJob: { select: { publisherId: true } } } } } as const;
  switch (entityType) {
    case 'build':
      return (await tx.buildJob.findUnique({ where: { id: entityId }, select: { publisherId: true } }))?.publisherId ?? null;
    case 'agent_run':
      return (await tx.agentRun.findUnique({ where: { id: entityId }, select: { publisherId: true } }))?.publisherId ?? null;
    case 'license':
      // Shown in the licensee publisher's activity.
      return (await tx.licenseGrant.findUnique({ where: { id: entityId }, select: { licenseeId: true } }))?.licenseeId ?? null;
    case 'artifact':
      return (await tx.artifact.findUnique({ where: { id: entityId }, select: { buildJob: { select: { publisherId: true } } } }))?.buildJob.publisherId ?? null;
    case 'sale':
      return (await tx.sale.findUnique({ where: { id: entityId }, select: viaArtifact }))?.artifact.buildJob.publisherId ?? null;
    case 'settlement':
      return (await tx.settlementRun.findUnique({ where: { id: entityId }, select: { sale: { select: viaArtifact } } }))?.sale.artifact.buildJob.publisherId ?? null;
    case 'payout_batch':
      return (
        (await tx.payoutBatch.findUnique({ where: { id: entityId }, select: { run: { select: { sale: { select: viaArtifact } } } } }))?.run.sale.artifact.buildJob
          .publisherId ?? null
      );
    default:
      return null;
  }
}

/**
 * Appends one event to the global hash chain inside the caller's transaction,
 * so the audit record commits atomically with the state change it describes.
 */
export async function appendAudit(tx: Tx, input: AuditInput): Promise<{ seq: number; hash: string }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
  const last = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const previousHash = last?.hash ?? GENESIS_HASH;
  const createdAt = new Date();
  const hash = chainHash(previousHash, {
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    payload: input.payload,
    createdAt: createdAt.toISOString(),
  });
  const row = await tx.auditEvent.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
      artifactId: input.artifactId ?? null,
      tenantId: input.tenantId !== undefined ? input.tenantId : await resolveTenant(tx, input.entityType, input.entityId),
      previousHash,
      hash,
      createdAt,
    },
    select: { seq: true, hash: true },
  });
  return row;
}

/** Re-computes the whole chain from the database. */
export async function verifyAuditChain(tx: Tx): Promise<{ ok: true; length: number } | { ok: false; brokenAtSeq: number }> {
  const rows = await tx.auditEvent.findMany({ orderBy: { seq: 'asc' } });
  const entries: StoredChainEntry[] = rows.map((r) => ({
    entityType: r.entityType,
    entityId: r.entityId,
    eventType: r.eventType,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
    previousHash: r.previousHash,
    hash: r.hash,
  }));
  const result = verifyChain(entries);
  return result.ok ? { ok: true, length: rows.length } : { ok: false, brokenAtSeq: rows[result.brokenAt]!.seq };
}
