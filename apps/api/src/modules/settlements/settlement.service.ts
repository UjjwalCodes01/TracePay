import { centsToDecimal, decimalToCents, EconomicsSchema } from '@tracepay/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { PayoutItemState } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import type { CitationReport } from '../generation/citations';
import { calculateSettlement, type FrozenTerm } from './engine';

export class SettlementStateError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'state' | 'payouts_unavailable' | 'provider' = 'state') {
    super(message);
    this.name = 'SettlementStateError';
  }
}

const FrozenSnapshotSchema = z.object({
  licenseId: z.string(),
  contributorId: z.string(),
  assetTitle: z.string(),
  economics: EconomicsSchema,
  payableOn: z.enum(['included_in_build', 'cited_in_output']),
});

/**
 * Calculates the settlement for a captured sale from the terms frozen on its
 * build — never the license's current terms. Idempotent: one run per sale.
 */
export async function calculateForSale(tx: Tx, saleId: string) {
  const existing = await tx.settlementRun.findUnique({ where: { saleId } });
  if (existing) return existing;

  const sale = await tx.sale.findUniqueOrThrow({
    where: { id: saleId },
    include: { payment: true, artifact: { include: { buildJob: { include: { sources: true } } } } },
  });
  if (sale.status !== 'captured' || sale.payment?.captureStatus !== 'COMPLETED' || sale.payment.capturedCents === null) {
    throw new SettlementStateError(`Sale ${saleId} has no verified completed capture; nothing is payable.`);
  }

  const build = sale.artifact.buildJob;
  const citations = sale.artifact.citationReport as unknown as CitationReport;
  const cited = new Set(citations.citedAssetVersionIds);

  const terms: FrozenTerm[] = build.sources.map((s) => {
    const snap = FrozenSnapshotSchema.parse(s.termsSnapshot);
    return {
      licenseId: snap.licenseId,
      assetVersionId: s.assetVersionId,
      assetTitle: snap.assetTitle,
      contributorId: snap.contributorId,
      payeeEmail: s.payeeEmail,
      economics: snap.economics,
      payableOn: snap.payableOn,
      citedInOutput: cited.has(s.assetVersionId),
    };
  });

  const result = calculateSettlement({
    verifiedGrossCents: sale.payment.capturedCents,
    currency: 'USD',
    publisherId: build.publisherId,
    terms,
  });

  const run = await tx.settlementRun.create({
    data: {
      saleId,
      snapshotHash: build.snapshotHash,
      grossCents: result.grossCents,
      contributorTotalCents: result.contributorTotalCents,
      publisherResidualCents: result.publisherResidualCents,
      roundingRule: result.roundingRule,
      lines: {
        create: result.lines.map((l) => ({
          kind: l.kind,
          recipientId: l.recipientId,
          payeeEmail: l.payeeEmail,
          licenseGrantId: l.licenseId,
          assetVersionId: l.assetVersionId,
          amountCents: l.amountCents,
          formula: l.formula,
          payable: l.payable,
          note: l.note,
        })),
      },
    },
  });

  await appendAudit(tx, {
    entityType: 'settlement',
    entityId: run.id,
    artifactId: sale.artifactId,
    eventType: 'settlement.calculated',
    payload: {
      saleId,
      buildSnapshotHash: build.snapshotHash,
      grossCents: result.grossCents,
      contributorTotalCents: result.contributorTotalCents,
      publisherResidualCents: result.publisherResidualCents,
      lines: result.lines.map((l) => ({ recipientId: l.recipientId, licenseId: l.licenseId, amountCents: l.amountCents, formula: l.formula, payable: l.payable })),
    },
  });
  return run;
}

/** A human (the publisher) must approve before any money moves to contributors. */
export async function approveSettlement(db: Db, runId: string, approverId: string) {
  return db.$transaction(async (tx) => {
    const run = await tx.settlementRun.findUnique({ where: { id: runId }, include: { sale: true } });
    if (!run) throw new SettlementStateError(`Settlement ${runId} not found.`, 'not_found');
    if (run.status === 'approved') return run;
    if (run.status !== 'calculated') throw new SettlementStateError(`Settlement is ${run.status}; only a calculated settlement can be approved.`);
    if (run.sale.status !== 'captured') throw new SettlementStateError(`Sale is ${run.sale.status}; settlement cannot be approved.`);

    const updated = await tx.settlementRun.update({
      where: { id: runId },
      data: { status: 'approved', approvedById: approverId, approvedAt: new Date() },
    });
    await appendAudit(tx, {
      entityType: 'settlement',
      entityId: runId,
      artifactId: run.sale.artifactId,
      eventType: 'settlement.approved',
      payload: { approverId },
    });
    return updated;
  });
}

const senderBatchIdFor = (runId: string) => `tp_${runId}`;

/**
 * Submits the payout batch. The batch and its items are recorded *before* the
 * PayPal call with a deterministic sender_batch_id, so any retry — after a
 * timeout, crash or 5xx — resends the identical batch and PayPal deduplicates it.
 */
export async function submitPayouts(db: Db, paypal: PayPalGateway, runId: string) {
  const run = await db.settlementRun.findUnique({ where: { id: runId }, include: { lines: true, batch: true, sale: true } });
  if (!run) throw new SettlementStateError(`Settlement ${runId} not found.`, 'not_found');
  if (run.batch?.paypalBatchId) return run.batch; // already accepted by PayPal
  if (run.status !== 'approved' && run.status !== 'payout_submitted') {
    throw new SettlementStateError(`Settlement is ${run.status}; approve it before paying out.`);
  }

  const payable = run.lines.filter((l) => l.kind === 'contributor' && l.payable && l.amountCents > 0);
  if (payable.length === 0) {
    await db.$transaction(async (tx) => {
      await tx.settlementRun.update({ where: { id: runId }, data: { status: 'completed' } });
      await appendAudit(tx, { entityType: 'settlement', entityId: runId, artifactId: run.sale.artifactId, eventType: 'settlement.completed', payload: { reason: 'no payable lines' } });
    });
    return null;
  }

  if (!(await paypal.hasPayoutsScope())) {
    throw new SettlementStateError(
      'This PayPal app does not have the Payouts permission. The settlement stays approved and queued; no payout has been sent.',
      'payouts_unavailable',
    );
  }

  const senderBatchId = senderBatchIdFor(runId);
  const batch =
    run.batch ??
    (await db.$transaction(async (tx) => {
      const b = await tx.payoutBatch.create({
        data: {
          runId,
          senderBatchId,
          status: 'SUBMITTING',
          items: {
            create: payable.map((l) => ({
              settlementLineId: l.id,
              senderItemId: l.id,
              receiver: l.payeeEmail!,
              amountCents: l.amountCents,
              status: 'SUBMITTING',
            })),
          },
        },
      });
      await tx.settlementRun.update({ where: { id: runId }, data: { status: 'payout_submitted' } });
      return b;
    }));

  const items = await db.payoutItem.findMany({ where: { batchId: batch.id }, include: { settlementLine: true } });

  let response;
  try {
    response = await paypal.createPayoutBatch({
      senderBatchId,
      emailSubject: 'You received a TracePay royalty',
      emailMessage: `Royalty for a licensed contribution to "${run.sale.artifactId}". Sale ${run.saleId}.`,
      items: items.map((i) => ({
        recipient_type: 'EMAIL' as const,
        receiver: i.receiver,
        amount: { value: centsToDecimal(i.amountCents), currency: 'USD' },
        sender_item_id: i.senderItemId,
        note: i.settlementLine.formula,
      })),
    });
  } catch (err) {
    const msg = err instanceof PayPalApiError ? `${err.message}${err.issue ? ` (${err.issue})` : ''}` : (err as Error).message;
    const duplicate = err instanceof PayPalApiError && err.status < 500 && /DUPLICATE|SENDER_BATCH_ID|already exists/i.test(JSON.stringify(err.body));
    if (duplicate) {
      // PayPal already holds a batch with this id: nothing was paid twice, but we lost its response.
      await db.$transaction(async (tx) => {
        await tx.payoutBatch.update({ where: { id: batch.id }, data: { status: 'DUPLICATE_REJECTED', lastResponse: { error: msg } } });
        await tx.settlementRun.update({ where: { id: runId }, data: { status: 'exception' } });
        await appendAudit(tx, {
          entityType: 'payout_batch',
          entityId: batch.id,
          artifactId: run.sale.artifactId,
          eventType: 'payout.duplicate_rejected',
          payload: { senderBatchId, error: msg, note: 'No second payment was made. Reconcile the original batch in the PayPal dashboard.' },
        });
      });
      throw new SettlementStateError('PayPal rejected a duplicate payout batch; no second payment was made. Flagged for reconciliation.', 'provider');
    }
    await db.$transaction(async (tx) => {
      await tx.payoutBatch.update({ where: { id: batch.id }, data: { status: 'SUBMIT_FAILED', lastResponse: { error: msg } } });
      await appendAudit(tx, {
        entityType: 'payout_batch',
        entityId: batch.id,
        artifactId: run.sale.artifactId,
        eventType: 'payout.submit_failed',
        payload: { senderBatchId, error: msg, retrySafe: true },
      });
    });
    throw new SettlementStateError(`PayPal payout submission failed; it is safe to retry (same sender_batch_id). ${msg}`, 'provider');
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.payoutBatch.update({
      where: { id: batch.id },
      data: {
        paypalBatchId: response.batch_header.payout_batch_id,
        status: response.batch_header.batch_status,
        lastResponse: response as unknown as Prisma.InputJsonValue,
        lastCheckedAt: new Date(),
      },
    });
    await tx.payoutItem.updateMany({ where: { batchId: batch.id }, data: { status: 'PENDING' } });
    await appendAudit(tx, {
      entityType: 'payout_batch',
      entityId: batch.id,
      artifactId: run.sale.artifactId,
      eventType: 'payout.submitted',
      payload: {
        senderBatchId,
        paypalBatchId: response.batch_header.payout_batch_id,
        batchStatus: response.batch_header.batch_status,
        items: items.map((i) => ({ senderItemId: i.senderItemId, receiver: i.receiver, amountCents: i.amountCents })),
      },
    });
    return updated;
  });
}

const FAILED_ITEM_STATES: PayoutItemState[] = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'];

/**
 * Pulls the authoritative batch and item statuses from PayPal. "Accepted" is
 * not "paid": a run completes only when every item reports SUCCESS, and any
 * failed/returned item turns the run into an exception for reconciliation.
 */
export async function refreshPayouts(db: Db, paypal: PayPalGateway, runId: string) {
  const batch = await db.payoutBatch.findUnique({ where: { runId }, include: { items: true, run: { include: { sale: true } } } });
  if (!batch?.paypalBatchId) throw new SettlementStateError('No payout batch has been accepted by PayPal yet.', 'state');

  const remote = await paypal.getPayoutBatch(batch.paypalBatchId);
  const bySender = new Map((remote.items ?? []).map((i) => [i.payout_item.sender_item_id, i]));

  return db.$transaction(async (tx) => {
    const changes: Array<{ senderItemId: string; from: string; to: string }> = [];
    for (const item of batch.items) {
      const r = bySender.get(item.senderItemId);
      if (!r) continue;
      if (r.transaction_status !== item.status) changes.push({ senderItemId: item.senderItemId, from: item.status, to: r.transaction_status });
      await tx.payoutItem.update({
        where: { id: item.id },
        data: {
          status: r.transaction_status,
          paypalItemId: r.payout_item_id,
          transactionId: r.transaction_id ?? null,
          errorName: r.errors?.name ?? null,
        },
      });
    }

    const statuses = batch.items.map((i) => bySender.get(i.senderItemId)?.transaction_status ?? i.status);
    const runStatus = statuses.some((s) => FAILED_ITEM_STATES.includes(s as PayoutItemState))
      ? 'exception'
      : statuses.every((s) => s === 'SUCCESS')
        ? 'completed'
        : 'payout_submitted';

    await tx.payoutBatch.update({
      where: { id: batch.id },
      data: { status: remote.batch_header.batch_status, lastResponse: remote as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date() },
    });
    if (batch.run.status !== runStatus) await tx.settlementRun.update({ where: { id: runId }, data: { status: runStatus } });

    if (changes.length || batch.status !== remote.batch_header.batch_status || batch.run.status !== runStatus) {
      await appendAudit(tx, {
        entityType: 'payout_batch',
        entityId: batch.id,
        artifactId: batch.run.sale.artifactId,
        eventType: 'payout.status_refreshed',
        payload: {
          paypalBatchId: batch.paypalBatchId,
          batchStatus: remote.batch_header.batch_status,
          runStatus,
          changes,
          fees: remote.batch_header.fees ? decimalToCents(remote.batch_header.fees.value) : null,
        },
      });
    }
    return { batchStatus: remote.batch_header.batch_status, runStatus, changes };
  });
}
