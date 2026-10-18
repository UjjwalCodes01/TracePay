import type { PreflightReport } from '@tracepay/shared';
import type { Tx } from '../../db';
import type { ArtifactContent } from '../generation/generation.service';
import { preflightSummary } from '../provenance/provenance.service';
import { verifyAuditChain } from './audit-log';
import { publicKeyPem, signDocument, type SigningKeys } from './signing';

export const RECEIPT_VERSION = 'tracepay-receipt/1';

export interface SignedReceipt {
  document: Record<string, unknown>;
  signature: string;
  algorithm: 'Ed25519';
  publicKeyPem: string;
}

/**
 * One document tying an artifact to its sources, rights check, PayPal
 * references, settlement formula and payout outcomes — signed so it can be
 * verified offline with TracePay's public key.
 */
export async function buildReceipt(tx: Tx, artifactId: string, keys: SigningKeys): Promise<SignedReceipt | null> {
  const artifact = await tx.artifact.findUnique({
    where: { id: artifactId },
    include: {
      buildJob: { include: { sources: { orderBy: { ordinal: 'asc' }, include: { assetVersion: { include: { asset: { include: { owner: true } } } } } } } },
      sales: {
        orderBy: { createdAt: 'asc' },
        include: { payment: true, settlement: { include: { lines: { include: { payoutItem: true } }, batch: true } } },
      },
    },
  });
  if (!artifact) return null;

  const content = artifact.content as unknown as ArtifactContent;
  const events = await tx.auditEvent.findMany({ where: { artifactId }, orderBy: { seq: 'asc' } });
  // Include how the build came to be: for an agent run, its blocked attempts and decisions too.
  const runId = artifact.buildJob.agentRunId;
  const runBuilds = runId ? await tx.buildJob.findMany({ where: { agentRunId: runId }, select: { id: true } }) : [];
  const buildEvents = await tx.auditEvent.findMany({
    where: {
      OR: [
        { entityType: 'build', entityId: { in: [artifact.buildJobId, ...runBuilds.map((b) => b.id)] } },
        ...(runId ? [{ entityType: 'agent_run', entityId: runId }] : []),
      ],
    },
    orderBy: { seq: 'asc' },
  });
  const chain = await verifyAuditChain(tx);
  const head = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });

  const document = {
    receiptVersion: RECEIPT_VERSION,
    issuedAt: new Date().toISOString(),
    artifact: {
      id: artifact.id,
      title: artifact.title,
      version: artifact.version,
      contentHash: artifact.contentHash,
      model: artifact.model,
      fromFixture: artifact.fromFixture,
      priceCents: artifact.priceCents,
      currency: artifact.currency,
      credits: content.credits.map((c) => c.text),
    },
    rights: {
      buildId: artifact.buildJobId,
      asOf: artifact.buildJob.asOf,
      snapshotHash: artifact.buildJob.snapshotHash,
      preflight: preflightSummary(artifact.buildJob.preflight as unknown as PreflightReport),
    },
    sources: artifact.buildJob.sources.map((s) => ({
      assetVersionId: s.assetVersionId,
      title: s.assetVersion.asset.title,
      owner: s.assetVersion.asset.owner.name,
      version: s.assetVersion.version,
      sha256: s.assetVersion.sha256,
      licenseId: s.licenseGrantId,
      cited: content.sources.find((x) => x.assetVersionId === s.assetVersionId)?.cited ?? false,
    })),
    sales: artifact.sales
      .filter((s) => s.payment?.captureId)
      .map((s) => ({
        saleId: s.id,
        status: s.status,
        paypal: {
          orderId: s.payment!.orderId,
          captureId: s.payment!.captureId,
          captureStatus: s.payment!.captureStatus,
          capturedCents: s.payment!.capturedCents,
        },
        settlement: s.settlement
          ? {
              runId: s.settlement.id,
              status: s.settlement.status,
              grossCents: s.settlement.grossCents,
              roundingRule: s.settlement.roundingRule,
              lines: s.settlement.lines.map((l) => ({
                kind: l.kind,
                recipientId: l.recipientId,
                licenseId: l.licenseGrantId,
                amountCents: l.amountCents,
                formula: l.formula,
                payout: l.payoutItem ? { status: l.payoutItem.status, paypalItemId: l.payoutItem.paypalItemId, transactionId: l.payoutItem.transactionId } : null,
              })),
              payoutBatch: s.settlement.batch
                ? { senderBatchId: s.settlement.batch.senderBatchId, paypalBatchId: s.settlement.batch.paypalBatchId, status: s.settlement.batch.status }
                : null,
            }
          : null,
      })),
    auditTrail: [...buildEvents, ...events]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({ seq: e.seq, eventType: e.eventType, at: e.createdAt.toISOString(), hash: e.hash })),
    chain: { verified: chain.ok, headSeq: head?.seq ?? null, headHash: head?.hash ?? null },
    disclaimer:
      'TracePay enforces the recorded, approved license terms and records verified PayPal outcomes. It does not establish legal ownership of source material and is not legal advice.',
  };

  return { document, signature: signDocument(document, keys), algorithm: 'Ed25519', publicKeyPem: publicKeyPem(keys) };
}
