import { centsToDecimal, decimalToCents, EconomicsSchema } from '@tracepay/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { PayoutItemState } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { openIssue, resolveIssues, saleOwner } from '../reconciliation/issues';
import { notifyScheduled, RESEND_SAFE_FOR_MS } from '../reconciliation/schedule';
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
          ...sending(),
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

/** A poll time that also wakes the reconciliation worker. */
const scheduledPoll = (inMs: number) => {
  const at = new Date(Date.now() + inMs);
  notifyScheduled(at);
  return at;
};

/** A send starts now: when it would count as interrupted, and when reconciliation looks again. */
const sending = () => {
  const now = Date.now();
  const nextPollAt = new Date(now + STALE_SUBMISSION_MS + 60_000);
  notifyScheduled(nextPollAt);
  return { sendingSince: new Date(now), nextPollAt, pollCount: 0 };
};

/** Re-claims an unfinished attempt for a resend with the SAME sender_batch_id. */
async function reclaim(tx: Tx, batch: { id: string; status: string; updatedAt: Date; createdAt: Date; sendingSince: Date | null }) {
  const since = batch.sendingSince ?? batch.updatedAt;
  const stale = batch.status === 'SUBMITTING' && Date.now() - since.getTime() > STALE_SUBMISSION_MS;
  if ((batch.status === 'SUBMIT_FAILED' || stale) && Date.now() - batch.createdAt.getTime() > RESEND_SAFE_FOR_MS) {
    // PayPal only rejects a reused sender_batch_id for 30 days: resending now could pay twice.
    throw new SettlementStateError('This payout batch is too old to resend safely. Check it in your PayPal dashboard first.', 'state');
  }
  if (batch.status === 'SUBMIT_FAILED' || stale) return tx.payoutBatch.update({ where: { id: batch.id }, data: { status: 'SUBMITTING', ...sending() } });
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
        const updated = await tx.payoutBatch.update({
          where: { id: batch.id },
          // Checked again later: if PayPal's webhook never brings its id, a person is told.
          data: { status: 'AWAITING_CONFIRMATION', lastResponse: { error: msg }, nextPollAt: scheduledPoll(15 * 60_000), pollCount: 0, sendingSince: null },
        });
        // An earlier "not sent" was wrong: PayPal had it all along.
        await resolveIssues(tx, { subjectId: batch.id, kinds: ['payout_submit_failed'], resolvedBy: 'auto', resolution: 'PayPal already had this batch.' });
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
      await tx.payoutBatch.update({ where: { id: batch.id }, data: { status: 'SUBMIT_FAILED', lastResponse: { error: msg }, sendingSince: null, nextPollAt: null } });
      await appendAudit(tx, { entityType: 'payout_batch', entityId: batch.id, artifactId, eventType: 'payout.submit_failed', payload: { senderBatchId: batch.senderBatchId, error: msg, retrySafe: true } });
      const owner = await saleOwner(tx, saleId);
      if (owner) await openIssue(tx, { ownerId: owner.ownerId, kind: 'payout_submit_failed', subjectType: 'payout_batch', subjectId: batch.id, artifactId, data: { attempt: batch.attempt } });
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
        // Reconciliation follows it from here, whether or not PayPal's webhooks arrive.
        nextPollAt: scheduledPoll(pollDelay(0)),
        pollCount: 0,
        sendingSince: null,
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
    const batch = await tx.payoutBatch.create({ data: { runId, attempt, senderBatchId: senderBatchIdFor(runId, attempt), status: 'SUBMITTING', ...sending() } });
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

/** Payout states PayPal won't change any more. */
export const FINAL_ITEM_STATES = new Set(['SUCCESS', 'FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED']);
const FINAL_BATCH_STATES = new Set(['SUCCESS', 'DENIED', 'CANCELED']);

/** When to ask PayPal again about an unfinished batch: soon at first, then daily. */
export const PAYOUT_POLL_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
/** Unfinished after this long: a person should look at it in PayPal. */
export const PAYOUT_STUCK_AFTER_MS = 45 * 24 * 3_600_000;
export const pollDelay = (pollCount: number) => PAYOUT_POLL_DELAYS_MS[Math.min(pollCount, PAYOUT_POLL_DELAYS_MS.length - 1)]!;

/** True once neither the batch nor any of its payouts can change any more. */
export function batchIsFinal(batchStatus: string, itemStatuses: string[]): boolean {
  if (batchStatus === 'DENIED' || batchStatus === 'CANCELED') return true;
  return FINAL_BATCH_STATES.has(batchStatus) && itemStatuses.every((s) => FINAL_ITEM_STATES.has(s));
}

/**
 * Pulls the authoritative statuses of ONE payout batch (any attempt) from
 * PayPal, re-derives the settlement's status, schedules the next poll (or stops
 * when everything is final) and opens/resolves "needs attention" issues.
 */
export async function refreshBatch(db: Db, paypal: PayPalGateway, batchId: string, opts: { pollCount?: number } = {}) {
  const batch = await db.payoutBatch.findUnique({ where: { id: batchId }, include: { items: true } });
  if (!batch) throw new SettlementStateError('Payout batch not found.', 'not_found');
  if (!batch.paypalBatchId) throw new SettlementStateError('This payout batch has not been accepted by PayPal yet.', 'state');
  const runId = batch.runId;

  const remote = await paypal.getPayoutBatch(batch.paypalBatchId);
  const bySender = new Map((remote.items ?? []).map((i) => [i.payout_item.sender_item_id, i]));

  return db.$transaction(async (tx) => {
    await lockRun(tx, runId);
    // Re-read under the lock: while PayPal answered, "Retry failed payouts" may have
    // moved items to a newer attempt. Only items still in THIS batch are updated —
    // writing stale rows back could let the same payout be retried (paid) twice.
    const items = await tx.payoutItem.findMany({ where: { batchId: batch.id } });
    const changes: Array<{ senderItemId: string; from: string; to: string }> = [];
    const statuses: string[] = [];
    for (const item of items) {
      const r = bySender.get(item.senderItemId);
      if (!r) {
        statuses.push(item.status);
        continue;
      }
      if (r.transaction_status !== item.status) changes.push({ senderItemId: item.senderItemId, from: item.status, to: r.transaction_status });
      statuses.push(r.transaction_status);
      await tx.payoutItem.updateMany({
        where: { id: item.id, batchId: batch.id, senderItemId: item.senderItemId },
        data: { status: r.transaction_status, paypalItemId: r.payout_item_id, transactionId: r.transaction_id ?? null, errorName: r.errors?.name ?? null },
      });
    }
    const now = new Date();
    const final = batchIsFinal(remote.batch_header.batch_status, statuses);
    const pollCount = opts.pollCount ?? batch.pollCount;
    const stuck = !final && now.getTime() - batch.createdAt.getTime() > PAYOUT_STUCK_AFTER_MS;
    await tx.payoutBatch.update({
      where: { id: batch.id },
      data: {
        status: remote.batch_header.batch_status,
        lastResponse: remote as unknown as Prisma.InputJsonValue,
        lastCheckedAt: now,
        pollCount,
        nextPollAt: final || stuck ? null : new Date(now.getTime() + pollDelay(pollCount)),
      },
    });

    const run = await tx.settlementRun.findUniqueOrThrow({ where: { id: runId }, include: { sale: { include: { artifact: { select: { buildJob: { select: { publisherId: true } } } } } } } });
    const latest = await tx.payoutBatch.findFirstOrThrow({ where: { runId }, orderBy: { attempt: 'desc' }, select: { id: true, status: true } });
    const allItems = await tx.payoutItem.findMany({ where: { batch: { runId } }, select: { status: true, receiver: true, amountCents: true, batch: { select: { paypalBatchId: true } } } });
    const runStatus = deriveRunStatus({
      saleStatus: run.sale.status,
      failureReason: run.failureReason,
      latestBatchStatus: latest.status,
      itemStatuses: allItems.map((i) => i.status),
      current: run.status,
    });
    if (run.status !== runStatus) await tx.settlementRun.update({ where: { id: runId }, data: { status: runStatus } });

    if (changes.length || batch.status !== remote.batch_header.batch_status || run.status !== runStatus) {
      await appendAudit(tx, {
        entityType: 'payout_batch',
        entityId: batch.id,
        artifactId: run.sale.artifactId,
        eventType: 'payout.status_refreshed',
        payload: {
          attempt: batch.attempt,
          paypalBatchId: batch.paypalBatchId,
          batchStatus: remote.batch_header.batch_status,
          runStatus,
          changes,
          fees: remote.batch_header.fees ? decimalToCents(remote.batch_header.fees.value) : null,
        },
      });
    }

    // What needs a person, from the facts just read.
    const ownerId = run.sale.artifact.buildJob.publisherId;
    const failed = allItems.filter((i) => FAILED_ITEM_STATES.includes(i.status as PayoutItemState));
    const unclaimed = allItems.filter((i) => i.status === 'UNCLAIMED');
    // Moved to a retry PayPal hasn't accepted yet: not delivered either.
    const unsent = allItems.filter((i) => !i.batch.paypalBatchId);
    if (failed.length || unsent.length) {
      await openIssue(tx, { ownerId, kind: 'payout_failed', subjectType: 'settlement', subjectId: runId, artifactId: run.sale.artifactId, data: { payouts: failed.length } });
    } else {
      await resolveIssues(tx, { subjectId: runId, kinds: ['payout_failed'], resolvedBy: 'auto', resolution: 'No failed payouts remain.' });
    }
    if (unclaimed.length) {
      await openIssue(tx, { ownerId, kind: 'payout_unclaimed', subjectType: 'settlement', subjectId: runId, artifactId: run.sale.artifactId, data: { payouts: unclaimed.length } });
    } else {
      await resolveIssues(tx, { subjectId: runId, kinds: ['payout_unclaimed'], resolvedBy: 'auto', resolution: 'Every payout was claimed or returned.' });
    }
    if (remote.batch_header.batch_status === 'DENIED') {
      await openIssue(tx, { ownerId, kind: 'payout_batch_denied', subjectType: 'payout_batch', subjectId: batch.id, artifactId: run.sale.artifactId, data: { attempt: batch.attempt } });
    }
    if (stuck) {
      await openIssue(tx, { ownerId, kind: 'payout_stuck', subjectType: 'payout_batch', subjectId: batch.id, artifactId: run.sale.artifactId, data: { attempt: batch.attempt } });
    }
    await resolveIssues(tx, { subjectId: batch.id, kinds: ['payout_unconfirmed', 'payout_submit_failed'], resolvedBy: 'auto', resolution: 'PayPal confirmed the batch.' });
    if (runStatus === 'completed') {
      const batchIds = (await tx.payoutBatch.findMany({ where: { runId }, select: { id: true } })).map((b) => b.id);
      for (const id of batchIds) await resolveIssues(tx, { subjectId: id, kinds: ['payout_batch_denied', 'payout_stuck'], resolvedBy: 'auto', resolution: 'All payouts completed.' });
    }
    return { batchStatus: remote.batch_header.batch_status, latestBatchStatus: latest.status, runStatus, changes, final };
  });
}

/** Refreshes every attempt PayPal has accepted (older attempts can still hold pending or unclaimed payouts). */
export async function refreshPayouts(db: Db, paypal: PayPalGateway, runId: string) {
  const batches = await db.payoutBatch.findMany({ where: { runId, paypalBatchId: { not: null } }, orderBy: { attempt: 'asc' }, select: { id: true } });
  if (batches.length === 0) throw new SettlementStateError('No payout batch has been accepted by PayPal yet.', 'state');
  let last: Awaited<ReturnType<typeof refreshBatch>> | null = null;
  const changes: Array<{ senderItemId: string; from: string; to: string }> = [];
  for (const b of batches) {
    last = await refreshBatch(db, paypal, b.id);
    changes.push(...last.changes);
  }
  return { batchStatus: last!.latestBatchStatus, runStatus: last!.runStatus, changes };
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
