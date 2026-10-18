import { centsToDecimal, decimalToCents, EconomicsSchema } from '@tracepay/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { PayoutItemState } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import type { CitationReport } from '../generation/citations';
import { calculateSettlement, SettlementError, type FrozenTerm } from './engine';

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

const SaleTermSchema = FrozenSnapshotSchema.extend({ assetVersionId: z.string(), payeeEmail: z.string().nullable() });

/**
 * The capture is recorded but its settlement can't be calculated (e.g. a
 * contributor has no payout address). The run is created as an exception so
 * it is visible and blocks payouts until someone resolves it.
 */
export async function recordFailedSettlement(tx: Tx, saleId: string, reason: string) {
  const existing = await tx.settlementRun.findUnique({ where: { saleId } });
  if (existing) return existing;
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { payment: true, artifact: { select: { id: true } } } });
  const gross = sale.payment?.capturedCents ?? sale.amountCents;
  const run = await tx.settlementRun.create({
    data: {
      saleId,
      snapshotHash: sale.snapshotHash ?? '',
      grossCents: gross,
      contributorTotalCents: 0,
      publisherResidualCents: gross,
      roundingRule: '',
      status: 'exception',
      failureReason: reason.slice(0, 500),
    },
  });
  await appendAudit(tx, { entityType: 'settlement', entityId: run.id, artifactId: sale.artifact.id, eventType: 'settlement.failed', payload: { saleId, reason } });
  return run;
}

/**
 * Calculates the settlement for a captured sale from the license terms in force
 * at the moment of sale (frozen on the sale) — later license changes never alter
 * it. Sales created before per-sale snapshots fall back to the build's terms.
 * Idempotent: one run per sale.
 */
export async function calculateForSale(tx: Tx, saleId: string, opts: { refreshPayees?: boolean } = {}) {
  const existing = await tx.settlementRun.findUnique({ where: { saleId } });
  if (existing) return existing;

  const sale = await tx.sale.findUniqueOrThrow({
    where: { id: saleId },
    include: { payment: true, artifact: { include: { buildJob: { include: { sources: { orderBy: { ordinal: 'asc' } } } } } } },
  });
  if (sale.status !== 'captured' || sale.payment?.captureStatus !== 'COMPLETED' || sale.payment.capturedCents === null) {
    throw new SettlementStateError(`Sale ${saleId} has no verified completed capture; nothing is payable.`);
  }

  const build = sale.artifact.buildJob;
  const citations = sale.artifact.citationReport as unknown as CitationReport;
  const cited = new Set(citations.citedAssetVersionIds);

  const terms: FrozenTerm[] = sale.termsSnapshot
    ? z.array(SaleTermSchema).parse(sale.termsSnapshot).map((t) => ({ ...t, citedInOutput: cited.has(t.assetVersionId) }))
    : build.sources.map((s) => {
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

  if (opts.refreshPayees) {
    const users = await tx.user.findMany({ where: { id: { in: terms.map((t) => t.contributorId) } }, select: { id: true, paypalEmail: true } });
    const current = new Map(users.map((u) => [u.id, u.paypalEmail]));
    for (const t of terms) t.payeeEmail = current.get(t.contributorId) ?? t.payeeEmail;
  }

  const result = calculateSettlement({
    verifiedGrossCents: sale.payment.capturedCents,
    currency: 'USD',
    publisherId: build.publisherId,
    terms,
  });

  const run = await tx.settlementRun.create({
    data: {
      saleId,
      snapshotHash: sale.snapshotHash ?? build.snapshotHash,
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

/**
 * Every state change of a settlement — approval, payout claims, refunds,
 * retries — takes this row lock first, so they serialise instead of racing.
 */
export async function lockRun(tx: Tx, runId: string) {
  await tx.$queryRaw`SELECT id FROM "SettlementRun" WHERE id = ${runId} FOR UPDATE`;
}

/** A human (the publisher) must approve before any money moves to contributors. */
export async function approveSettlement(db: Db, runId: string, approverId: string) {
  return db.$transaction(async (tx) => {
    await lockRun(tx, runId);
    const run = await tx.settlementRun.findUnique({ where: { id: runId }, include: { sale: true } });
    if (!run) throw new SettlementStateError(`Settlement ${runId} not found.`, 'not_found');
    if (run.status === 'approved') return run;
    if (run.status !== 'calculated') throw new SettlementStateError(`Settlement is ${run.status}; only a calculated settlement can be approved.`);
    if (run.sale.status !== 'captured') throw new SettlementStateError(`The sale is ${run.sale.status}; nothing can be paid out.`);

    const updated = await tx.settlementRun.update({
      where: { id: runId },
      data: { status: 'approved', approvedById: approverId, approvedAt: new Date() },
    });
    await appendAudit(tx, { entityType: 'settlement', entityId: runId, artifactId: run.sale.artifactId, eventType: 'settlement.approved', payload: { approverId } });
    return updated;
  });
}

const senderBatchIdFor = (runId: string, attempt: number) => (attempt === 1 ? `tp_${runId}` : `tp_${runId}_r${attempt}`);
/** A submission still "SUBMITTING" after this long is assumed abandoned and may be resent (same id). */
export const STALE_SUBMISSION_MS = 2 * 60_000;
const FAILED_ITEM_STATES: PayoutItemState[] = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'];

type BatchRow = { id: string; runId: string; attempt: number; senderBatchId: string; paypalBatchId: string | null; status: string };

/**
 * Submits attempt 1. The batch and its items are recorded *before* the PayPal
 * call with a deterministic sender_batch_id, so a retry after a timeout or a
 * crash resends the identical batch and PayPal refuses to pay it twice.
 */
export async function submitPayouts(db: Db, paypal: PayPalGateway, runId: string) {
  const run = await db.settlementRun.findUnique({ where: { id: runId }, include: { lines: true, batches: { orderBy: { attempt: 'desc' }, take: 1 }, sale: true } });
  if (!run) throw new SettlementStateError(`Settlement ${runId} not found.`, 'not_found');
  const current = run.batches[0];
  if (current?.paypalBatchId) return current; // already accepted by PayPal
  if (run.sale.status !== 'captured') throw new SettlementStateError(`The sale is ${run.sale.status}; nothing can be paid out.`);
  if (!current && run.status !== 'approved') throw new SettlementStateError(`Settlement is ${run.status}; approve it before paying out.`);

  const payable = run.lines.filter((l) => l.kind === 'contributor' && l.payable && l.amountCents > 0);
  if (!current && payable.length === 0) {
    await db.$transaction(async (tx) => {
      await lockRun(tx, runId);
      await tx.settlementRun.updateMany({ where: { id: runId, status: 'approved' }, data: { status: 'completed' } });
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

  const claim = await db.$transaction(async (tx) => {
    await lockRun(tx, runId);
    const fresh = await tx.settlementRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true, batches: { orderBy: { attempt: 'desc' }, take: 1 } } });
    if (fresh.sale.status !== 'captured') throw new SettlementStateError(`The sale is ${fresh.sale.status}; nothing can be paid out.`);
    const latest = fresh.batches[0];
    if (latest?.paypalBatchId) return { batch: latest as BatchRow, proceed: false };
    if (!latest) {
      if (fresh.status !== 'approved') throw new SettlementStateError(`Settlement is ${fresh.status}; approve it before paying out.`);
      const created = await tx.payoutBatch.create({
        data: {
          runId,
          attempt: 1,
          senderBatchId: senderBatchIdFor(runId, 1),
          status: 'SUBMITTING',
          items: {
            create: payable.map((l) => ({ settlementLineId: l.id, senderItemId: l.id, receiver: l.payeeEmail!, amountCents: l.amountCents, status: 'SUBMITTING' })),
          },
        },
      });
      await tx.settlementRun.update({ where: { id: runId }, data: { status: 'payout_submitted' } });
      return { batch: created as BatchRow, proceed: true };
    }
    return { batch: (await reclaim(tx, latest)) as BatchRow, proceed: true };
  });
  if (!claim.proceed) return claim.batch;
  return sendBatch(db, paypal, claim.batch, run.sale.artifactId, run.saleId);
}

/** Re-claims an unfinished attempt for a resend with the SAME sender_batch_id. */
async function reclaim(tx: Tx, batch: { id: string; status: string; updatedAt: Date }) {
  const stale = batch.status === 'SUBMITTING' && Date.now() - batch.updatedAt.getTime() > STALE_SUBMISSION_MS;
  if (batch.status === 'SUBMIT_FAILED' || stale) return tx.payoutBatch.update({ where: { id: batch.id }, data: { status: 'SUBMITTING' } });
  if (batch.status === 'SUBMITTING') throw new SettlementStateError('These payouts are already being sent. Refresh in a moment.');
  if (batch.status === 'AWAITING_CONFIRMATION') throw new SettlementStateError('PayPal already received these payouts; their status will update automatically.');
  throw new SettlementStateError(`This payout batch is ${batch.status.toLowerCase().replace(/_/g, ' ')} and needs reconciliation.`);
}

/** One PayPal call per attempt. The client never retries this POST by itself. */
async function sendBatch(db: Db, paypal: PayPalGateway, batch: BatchRow, artifactId: string, saleId: string) {
  const items = await db.payoutItem.findMany({ where: { batchId: batch.id }, include: { settlementLine: true } });
  let response;
  try {
    response = await paypal.createPayoutBatch({
      senderBatchId: batch.senderBatchId,
      emailSubject: 'You received a TracePay royalty',
      emailMessage: `Your share of a TracePay report sale (sale ${saleId}).`,
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
      // PayPal already holds a batch with this id (an earlier call succeeded but its response was lost).
      // Nothing was paid twice. Its id arrives with PayPal's payout webhook, which matches on sender_batch_id.
      return db.$transaction(async (tx) => {
        const updated = await tx.payoutBatch.update({ where: { id: batch.id }, data: { status: 'AWAITING_CONFIRMATION', lastResponse: { error: msg } } });
        await appendAudit(tx, {
          entityType: 'payout_batch',
          entityId: batch.id,
          artifactId,
          eventType: 'payout.duplicate_detected',
          payload: { senderBatchId: batch.senderBatchId, note: 'PayPal already has this batch; no second payment was made. Awaiting its confirmation.' },
        });
        return updated;
      });
    }
    await db.$transaction(async (tx) => {
      await tx.payoutBatch.update({ where: { id: batch.id }, data: { status: 'SUBMIT_FAILED', lastResponse: { error: msg } } });
      await appendAudit(tx, { entityType: 'payout_batch', entityId: batch.id, artifactId, eventType: 'payout.submit_failed', payload: { senderBatchId: batch.senderBatchId, error: msg, retrySafe: true } });
    });
    throw new SettlementStateError('PayPal did not accept the payouts. Nothing was sent; it is safe to try again.', 'provider');
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
      artifactId,
      eventType: 'payout.submitted',
      payload: {
        attempt: batch.attempt,
        senderBatchId: batch.senderBatchId,
        paypalBatchId: response.batch_header.payout_batch_id,
        batchStatus: response.batch_header.batch_status,
        items: items.map((i) => ({ senderItemId: i.senderItemId, receiver: i.receiver, amountCents: i.amountCents })),
      },
    });
    return updated;
  });
}

/**
 * Retries only the items PayPal reported as failed or returned, in a new
 * numbered attempt, using each contributor's CURRENT payout address (the usual
 * fix is that they corrected it). Earlier attempts stay in each item's history.
 */
export async function retryFailedPayouts(db: Db, paypal: PayPalGateway, runId: string) {
  if (!(await paypal.hasPayoutsScope())) throw new SettlementStateError('This PayPal app does not have the Payouts permission.', 'payouts_unavailable');
  const prepared = await db.$transaction(async (tx) => {
    await lockRun(tx, runId);
    const run = await tx.settlementRun.findUnique({ where: { id: runId }, include: { sale: true, batches: { orderBy: { attempt: 'desc' }, take: 1 } } });
    if (!run) throw new SettlementStateError(`Settlement ${runId} not found.`, 'not_found');
    if (run.sale.status !== 'captured') throw new SettlementStateError(`The sale is ${run.sale.status}; nothing can be paid out.`);
    const latest = run.batches[0];
    if (!latest?.paypalBatchId) throw new SettlementStateError('There is no accepted payout batch to retry yet.');

    const items = await tx.payoutItem.findMany({ where: { batch: { runId } }, include: { settlementLine: true, batch: true } });
    const failed = items.filter((i) => FAILED_ITEM_STATES.includes(i.status as PayoutItemState));
    if (failed.length === 0) throw new SettlementStateError('There are no failed payouts to retry.');

    const attempt = latest.attempt + 1;
    const batch = await tx.payoutBatch.create({ data: { runId, attempt, senderBatchId: senderBatchIdFor(runId, attempt), status: 'SUBMITTING' } });
    const payees = await tx.user.findMany({ where: { id: { in: failed.map((f) => f.settlementLine.recipientId) } }, select: { id: true, paypalEmail: true } });
    const payeeOf = new Map(payees.map((p) => [p.id, p.paypalEmail]));
    for (const item of failed) {
      const history = Array.isArray(item.attempts) ? (item.attempts as Prisma.JsonArray) : [];
      await tx.payoutItem.update({
        where: { id: item.id },
        data: {
          batchId: batch.id,
          senderItemId: `${item.settlementLineId}_r${attempt}`,
          receiver: payeeOf.get(item.settlementLine.recipientId) ?? item.receiver,
          status: 'SUBMITTING',
          paypalItemId: null,
          transactionId: null,
          errorName: null,
          attempts: [
            ...history,
            { attempt: item.batch.attempt, paypalBatchId: item.batch.paypalBatchId, paypalItemId: item.paypalItemId, receiver: item.receiver, status: item.status, errorName: item.errorName },
          ] as Prisma.InputJsonValue,
        },
      });
    }
    await tx.settlementRun.update({ where: { id: runId }, data: { status: 'payout_submitted' } });
    await appendAudit(tx, { entityType: 'payout_batch', entityId: batch.id, artifactId: run.sale.artifactId, eventType: 'payout.retry_created', payload: { attempt, items: failed.map((f) => f.settlementLineId) } });
    return { batch: batch as BatchRow, artifactId: run.sale.artifactId, saleId: run.saleId };
  });
  return sendBatch(db, paypal, prepared.batch, prepared.artifactId, prepared.saleId);
}

/**
 * The settlement's status, derived from facts rather than remembered: a sale
 * that is no longer captured (refunded / reversed), a failed calculation, a
 * batch PayPal denied, or any failed item makes it an exception; it completes
 * only when every payout item reports SUCCESS.
 */
export function deriveRunStatus(input: {
  saleStatus: string;
  failureReason: string | null;
  latestBatchStatus: string | null;
  itemStatuses: string[];
  current: string;
}): 'calculated' | 'approved' | 'payout_submitted' | 'completed' | 'exception' {
  if (input.saleStatus !== 'captured' || input.failureReason) return 'exception';
  if (input.latestBatchStatus && ['DENIED', 'CANCELED'].includes(input.latestBatchStatus)) return 'exception';
  if (input.itemStatuses.some((s) => FAILED_ITEM_STATES.includes(s as PayoutItemState))) return 'exception';
  if (input.itemStatuses.length > 0 && input.itemStatuses.every((s) => s === 'SUCCESS')) return 'completed';
  if (input.itemStatuses.length > 0) return 'payout_submitted';
  return input.current as 'calculated' | 'approved';
}

/** Pulls the authoritative statuses of the latest attempt from PayPal. */
export async function refreshPayouts(db: Db, paypal: PayPalGateway, runId: string) {
  const latest = await db.payoutBatch.findFirst({ where: { runId }, orderBy: { attempt: 'desc' }, include: { items: true } });
  if (!latest?.paypalBatchId) throw new SettlementStateError('No payout batch has been accepted by PayPal yet.', 'state');

  const remote = await paypal.getPayoutBatch(latest.paypalBatchId);
  const bySender = new Map((remote.items ?? []).map((i) => [i.payout_item.sender_item_id, i]));

  return db.$transaction(async (tx) => {
    await lockRun(tx, runId);
    const changes: Array<{ senderItemId: string; from: string; to: string }> = [];
    for (const item of latest.items) {
      const r = bySender.get(item.senderItemId);
      if (!r) continue;
      if (r.transaction_status !== item.status) changes.push({ senderItemId: item.senderItemId, from: item.status, to: r.transaction_status });
      await tx.payoutItem.update({
        where: { id: item.id },
        data: { status: r.transaction_status, paypalItemId: r.payout_item_id, transactionId: r.transaction_id ?? null, errorName: r.errors?.name ?? null },
      });
    }
    await tx.payoutBatch.update({
      where: { id: latest.id },
      data: { status: remote.batch_header.batch_status, lastResponse: remote as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date() },
    });

    const run = await tx.settlementRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: true } });
    const allItems = await tx.payoutItem.findMany({ where: { batch: { runId } }, select: { status: true } });
    const runStatus = deriveRunStatus({
      saleStatus: run.sale.status,
      failureReason: run.failureReason,
      latestBatchStatus: remote.batch_header.batch_status,
      itemStatuses: allItems.map((i) => i.status),
      current: run.status,
    });
    if (run.status !== runStatus) await tx.settlementRun.update({ where: { id: runId }, data: { status: runStatus } });

    if (changes.length || latest.status !== remote.batch_header.batch_status || run.status !== runStatus) {
      await appendAudit(tx, {
        entityType: 'payout_batch',
        entityId: latest.id,
        artifactId: run.sale.artifactId,
        eventType: 'payout.status_refreshed',
        payload: {
          attempt: latest.attempt,
          paypalBatchId: latest.paypalBatchId,
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

/**
 * A settlement whose calculation failed (e.g. a contributor had no payout
 * address) can be recalculated once the cause is fixed. Uses the terms frozen
 * on the sale, with each contributor's current payout address.
 */
export async function recalculateSettlement(db: Db, runId: string) {
  return db.$transaction(async (tx) => {
    await lockRun(tx, runId);
    const run = await tx.settlementRun.findUnique({ where: { id: runId }, include: { batches: { select: { id: true } }, sale: true } });
    if (!run) throw new SettlementStateError(`Settlement ${runId} not found.`, 'not_found');
    if (run.status !== 'exception' || !run.failureReason || run.batches.length) {
      throw new SettlementStateError('Only a settlement whose calculation failed can be recalculated.');
    }
    if (run.sale.status !== 'captured') throw new SettlementStateError(`The sale is ${run.sale.status}; nothing can be paid out.`);
    await tx.settlementRun.delete({ where: { id: runId } });
    try {
      const fresh = await calculateForSale(tx, run.saleId, { refreshPayees: true });
      await appendAudit(tx, { entityType: 'settlement', entityId: fresh.id, artifactId: run.sale.artifactId, eventType: 'settlement.recalculated', payload: { replaces: runId } });
      return fresh;
    } catch (err) {
      if (!(err instanceof SettlementError || err instanceof SettlementStateError || err instanceof z.ZodError)) throw err;
      return recordFailedSettlement(tx, run.saleId, (err as Error).message);
    }
  });
}
