import { answersEnv } from '../../config/env';
import { randomBytes } from 'node:crypto';
import { centsToDecimal } from '@tracepay/shared';
import type { Db, Tx } from '../../db';
import { PAYOUT_PAGE_SIZE, PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { PayoutBatchStatus } from '../../integrations/paypal/types';
import { appendAudit, lockAuditChain } from '../audit/audit-log';
import { RESEND_SAFE_FOR_MS, after, notifyScheduled } from '../reconciliation/schedule';
import { SettlementStateError, STALE_SUBMISSION_MS } from '../settlements/settlement.service';

/**
 * Paying contributors what answers earned them. Citations are worth cents, so
 * credits accrue and are paid in one PayPal Payouts batch per contributor total,
 * once it's worth sending and the money that funded them has cleared.
 *
 * A batch's sender_batch_id is fixed before it is first sent, and a send is
 * claimed in a transaction, so PayPal can only ever receive it once:
 *  - a lost response, then a resend → PayPal says "duplicate" → we wait for its
 *    webhook / the next poll instead of trying again;
 *  - PayPal remembers sender_batch_ids for 30 days, so no resend after 25;
 *  - a definite rejection (a 4xx that isn't "duplicate") never created a batch:
 *    its credits go straight back into the pool.
 * Then reconciliation reads the batch back until every item is final, also
 * catching a payout that succeeded and was later returned or reversed.
 */


/** Smallest total worth one payout (PayPal charges a fee per payout). */
export const royaltyMinimumCents = () => answersEnv().ROYALTY_PAYOUT_MIN_CENTS ?? (process.env.DEMO_MODE === 'true' ? 1 : 100);

/**
 * Credits become payable only after this many days, so a buyer's chargeback or
 * refund lands before the money has gone out (and the credit can be clawed back).
 */
export const clearingDays = () => answersEnv().CREDIT_CLEARING_DAYS ?? (process.env.DEMO_MODE === 'true' ? 0 : 14);

const DAY = 24 * 60 * 60_000;
const FAILED = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED']);
/** Items still moving at PayPal: keep polling while any item is one of these. */
const OPEN_ITEM = new Set(['SUBMITTING', 'PENDING', 'UNCLAIMED', 'ONHOLD']);
/** Poll schedule: soon after sending, then rarer; UNCLAIMED items resolve within ~30 days. */
const POLL_DELAYS_MS = [5 * 60_000, 30 * 60_000, 3 * 60 * 60_000, 12 * 60 * 60_000, DAY];
const POLL_FOR_MS = 45 * DAY;

const pollAt = (count: number) => after(POLL_DELAYS_MS[Math.min(count, POLL_DELAYS_MS.length - 1)]!);

export async function royaltySummary(db: Db, libraryId: string) {
  const clearBefore = new Date(Date.now() - clearingDays() * DAY);
  const [accrued, clearing, payouts, totals] = await Promise.all([
    db.citationCredit.groupBy({ by: ['contributorId'], where: { libraryId, status: 'accrued' }, _sum: { amountCents: true, citations: true }, _count: { _all: true } }),
    db.citationCredit.groupBy({ by: ['contributorId'], where: { libraryId, status: 'accrued', createdAt: { gt: clearBefore } }, _sum: { amountCents: true } }),
    db.royaltyPayout.findMany({ where: { libraryId }, orderBy: { createdAt: 'desc' }, take: 20, include: { items: true } }),
    db.answer.aggregate({ where: { libraryId, status: 'answered' }, _count: { _all: true }, _sum: { chargedCents: true, feeCents: true } }),
  ]);
  const people = await db.user.findMany({
    where: { id: { in: [...new Set([...accrued.map((a) => a.contributorId), ...payouts.flatMap((p) => p.items.map((i) => i.contributorId))])] } },
    select: { id: true, name: true, paypalEmail: true },
  });
  const who = new Map(people.map((p) => [p.id, p]));
  const notCleared = new Map(clearing.map((c) => [c.contributorId, c._sum.amountCents ?? 0]));
  const minimum = royaltyMinimumCents();
  return {
    minimumCents: minimum,
    clearingDays: clearingDays(),
    answers: totals._count._all,
    revenueCents: totals._sum.chargedCents ?? 0,
    feesCents: totals._sum.feeCents ?? 0,
    accrued: accrued
      .map((a) => {
        const amount = a._sum.amountCents ?? 0;
        const clearingCents = notCleared.get(a.contributorId) ?? 0;
        const hasPayee = !!who.get(a.contributorId)?.paypalEmail;
        return {
          contributorId: a.contributorId,
          name: who.get(a.contributorId)?.name ?? a.contributorId,
          hasPayee,
          amountCents: amount,
          clearingCents,
          citations: a._sum.citations ?? 0,
          answers: a._count._all,
          payable: hasPayee && amount - clearingCents >= minimum,
        };
      })
      .sort((x, y) => y.amountCents - x.amountCents),
    payouts: payouts.map((p) => ({
      id: p.id,
      status: p.status,
      totalCents: p.totalCents,
      paypalBatchId: p.paypalBatchId,
      createdAt: p.createdAt,
      lastCheckedAt: p.lastCheckedAt,
      resendable: p.status === 'SUBMIT_FAILED' && Date.now() - p.createdAt.getTime() < RESEND_SAFE_FOR_MS,
      items: p.items.map((i) => ({ id: i.id, name: who.get(i.contributorId)?.name ?? i.contributorId, amountCents: i.amountCents, status: i.status, transactionId: i.transactionId, errorName: i.errorName })),
    })),
  };
}

/** Groups every payable, cleared credit into one Payouts batch, then sends it. */
export async function sendRoyaltyPayout(db: Db, paypal: PayPalGateway, libraryId: string) {
  if (!(await paypal.hasPayoutsScope())) throw new SettlementStateError('This PayPal app does not have the Payouts permission.', 'payouts_unavailable');
  const minimum = royaltyMinimumCents();
  const clearBefore = new Date(Date.now() - clearingDays() * DAY);
  const payoutId = await db.$transaction(async (tx) => {
    await lockAuditChain(tx);
    // Lock this library's unpaid credits: a credit can be in one batch only.
    const rows = await tx.$queryRaw<Array<{ id: string; contributorId: string; amountCents: number }>>`
      SELECT id, "contributorId", "amountCents" FROM "CitationCredit"
      WHERE "libraryId" = ${libraryId} AND status = 'accrued' AND "createdAt" <= ${clearBefore}
      ORDER BY "createdAt" FOR UPDATE`;
    const payees = await tx.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.contributorId))] } }, select: { id: true, paypalEmail: true } });
    const email = new Map(payees.map((p) => [p.id, p.paypalEmail]));
    const groups = new Map<string, { total: number; ids: string[] }>();
    for (const r of rows) {
      if (!email.get(r.contributorId)) continue;
      const g = groups.get(r.contributorId) ?? { total: 0, ids: [] };
      g.total += r.amountCents;
      g.ids.push(r.id);
      groups.set(r.contributorId, g);
    }
    // One batch holds at most a page of items, so it can always be read back in full.
    const payable = [...groups].filter(([, g]) => g.total >= minimum).slice(0, PAYOUT_PAGE_SIZE);
    if (payable.length === 0) throw new SettlementStateError('Nothing is ready to pay yet: no author has reached the payout minimum, or their earnings are still clearing.');

    const batchKey = randomBytes(8).toString('hex');
    const payout = await tx.royaltyPayout.create({
      data: { libraryId, senderBatchId: `royalties_${batchKey}`, status: 'SUBMITTING', sendingSince: new Date(), totalCents: payable.reduce((n, [, g]) => n + g.total, 0) },
    });
    for (const [n, [contributorId, g]] of payable.entries()) {
      const item = await tx.royaltyPayoutItem.create({
        data: { payoutId: payout.id, senderItemId: `royalties_${batchKey}_${n + 1}`, contributorId, receiver: email.get(contributorId)!, amountCents: g.total },
      });
      await tx.citationCredit.updateMany({ where: { id: { in: g.ids } }, data: { status: 'in_payout', payoutItemId: item.id } });
    }
    await appendAudit(tx, { entityType: 'royalty_payout', entityId: payout.id, tenantId: libraryId, eventType: 'royalties.payout_created', payload: { totalCents: payout.totalCents, contributors: payable.length, senderBatchId: payout.senderBatchId } });
    return payout.id;
  });
  return sendClaimed(db, paypal, payoutId);
}

/**
 * Re-sends a batch PayPal never confirmed, with the SAME sender_batch_id. Claimed in
 * a transaction (two clicks can't both send) and refused once PayPal may have
 * forgotten the id (it could then pay twice).
 */
export async function submitRoyaltyPayout(db: Db, paypal: PayPalGateway, payoutId: string) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RoyaltyPayout" WHERE id = ${payoutId} FOR UPDATE`;
    const p = await tx.royaltyPayout.findUniqueOrThrow({ where: { id: payoutId } });
    if (p.paypalBatchId) throw new SettlementStateError('PayPal already has this batch; its status updates automatically.');
    const interrupted = p.status === 'SUBMITTING' && (!p.sendingSince || Date.now() - p.sendingSince.getTime() > STALE_SUBMISSION_MS);
    if (p.status === 'SUBMITTING' && !interrupted) throw new SettlementStateError('This batch is being sent right now. Check again in a moment.');
    if (p.status === 'AWAITING_CONFIRMATION') throw new SettlementStateError('PayPal already received this batch; its status will update automatically.');
    if (p.status !== 'SUBMIT_FAILED' && !interrupted) throw new SettlementStateError(`This batch can’t be sent again (it is ${p.status.toLowerCase().replace(/_/g, ' ')}).`);
    if (Date.now() - p.createdAt.getTime() > RESEND_SAFE_FOR_MS) {
      throw new SettlementStateError('This batch is too old to resend safely: PayPal may have forgotten it and pay twice. Check your PayPal dashboard first.');
    }
    await tx.royaltyPayout.update({ where: { id: payoutId }, data: { status: 'SUBMITTING', sendingSince: new Date() } });
  });
  return sendClaimed(db, paypal, payoutId);
}

/** The one PayPal call for a batch this process has claimed (status SUBMITTING). */
async function sendClaimed(db: Db, paypal: PayPalGateway, payoutId: string) {
  const payout = await db.royaltyPayout.findUniqueOrThrow({ where: { id: payoutId }, include: { items: true } });
  let res;
  try {
    res = await paypal.createPayoutBatch({
      senderBatchId: payout.senderBatchId,
      emailSubject: 'You were paid for AI answers that cited your work',
      emailMessage: 'TracePay paid you for passages of your licensed work that AI answers verifiably relied on.',
      items: payout.items.map((i) => ({
        recipient_type: 'EMAIL',
        receiver: i.receiver,
        amount: { value: centsToDecimal(i.amountCents), currency: 'USD' },
        note: 'Pay-per-citation royalties from TracePay answers',
        sender_item_id: i.senderItemId,
      })),
    });
  } catch (err) {
    const api = err instanceof PayPalApiError ? err : null;
    const duplicate = api && api.status < 500 && /DUPLICATE|SENDER_BATCH_ID|already exists/i.test(JSON.stringify(api.body));
    const rejected = api && !duplicate && api.status >= 400 && api.status < 500 && !api.retryable && api.status !== 401 && api.status !== 403;
    await db.$transaction(async (tx) => {
      await lockAuditChain(tx);
      if (duplicate) {
        // An earlier send got through and its reply was lost: PayPal has it. Its id comes with
        // PayPal's payout webhook (matched on sender_batch_id); nothing is sent again.
        await tx.royaltyPayout.update({ where: { id: payoutId }, data: { status: 'AWAITING_CONFIRMATION', sendingSince: null } });
        await appendAudit(tx, { entityType: 'royalty_payout', entityId: payoutId, tenantId: payout.libraryId, eventType: 'royalties.payout_duplicate', payload: { senderBatchId: payout.senderBatchId } });
      } else if (rejected) {
        // PayPal refused it outright (it never created a batch): the money goes back to the pool.
        await tx.royaltyPayout.update({ where: { id: payoutId }, data: { status: 'REJECTED', sendingSince: null } });
        await tx.royaltyPayoutItem.updateMany({ where: { payoutId }, data: { status: 'REJECTED', errorName: api!.issue ?? `HTTP ${api!.status}` } });
        await tx.citationCredit.updateMany({ where: { payoutItem: { payoutId }, status: 'in_payout' }, data: { status: 'accrued', payoutItemId: null } });
        await appendAudit(tx, { entityType: 'royalty_payout', entityId: payoutId, tenantId: payout.libraryId, eventType: 'royalties.payout_rejected', payload: { status: api!.status, issue: api!.issue ?? null } });
      } else {
        // Unknown (network, PayPal 5xx, timeout): safe to resend with the same id.
        await tx.royaltyPayout.update({ where: { id: payoutId }, data: { status: 'SUBMIT_FAILED', sendingSince: null } });
        await appendAudit(tx, { entityType: 'royalty_payout', entityId: payoutId, tenantId: payout.libraryId, eventType: 'royalties.payout_submit_failed', payload: { retrySafe: true } });
      }
    });
    if (duplicate) return royaltyPayoutOut(payoutId, db);
    throw new SettlementStateError(
      rejected ? 'PayPal refused this payout batch, so nothing was sent. The amounts are back in “Ready to pay”.' : 'PayPal didn’t confirm the payout batch. Nothing was sent twice; it is safe to send it again.',
      'provider',
    );
  }
  const next = pollAt(0);
  await db.royaltyPayout.update({
    where: { id: payoutId },
    data: { paypalBatchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status, sendingSince: null, nextPollAt: next, pollCount: 0 },
  });
  await db.royaltyPayoutItem.updateMany({ where: { payoutId, status: 'SUBMITTING' }, data: { status: 'PENDING' } });
  notifyScheduled(next);
  return royaltyPayoutOut(payoutId, db);
}

/** PayPal's view of a batch, every page of items. */
async function readBatch(paypal: PayPalGateway, paypalBatchId: string): Promise<PayoutBatchStatus> {
  const first = await paypal.getPayoutBatch(paypalBatchId, 1);
  const items = [...(first.items ?? [])];
  for (let page = 2; (first.items?.length ?? 0) >= PAYOUT_PAGE_SIZE && items.length === (page - 1) * PAYOUT_PAGE_SIZE && page <= 50; page++) {
    items.push(...((await paypal.getPayoutBatch(paypalBatchId, page)).items ?? []));
  }
  return { ...first, items };
}

/**
 * Reads the batch back from PayPal. Paid credits are final unless PayPal later reports the
 * payment returned or reversed; failed ones go back to the pool for the next batch.
 */
export async function refreshRoyaltyPayout(db: Db, paypal: PayPalGateway, payoutId: string) {
  const payout = await db.royaltyPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (!payout.paypalBatchId) return royaltyPayoutOut(payoutId, db);
  const remote = await readBatch(paypal, payout.paypalBatchId);
  const batchStatus = remote.batch_header.batch_status;
  await db.$transaction(async (tx) => {
    await lockAuditChain(tx);
    await tx.$queryRaw`SELECT id FROM "RoyaltyPayout" WHERE id = ${payoutId} FOR UPDATE`;
    const items = await tx.royaltyPayoutItem.findMany({ where: { payoutId } });
    const remoteBySender = new Map((remote.items ?? []).map((r) => [r.payout_item.sender_item_id, r]));
    const wholeBatchFailed = batchStatus === 'DENIED' || batchStatus === 'CANCELED';
    for (const item of items) {
      const r = remoteBySender.get(item.senderItemId);
      const status = r?.transaction_status ?? (wholeBatchFailed ? batchStatus : item.status);
      if (status !== item.status || r) {
        await tx.royaltyPayoutItem.update({
          where: { id: item.id },
          data: { status, paypalItemId: r?.payout_item_id ?? item.paypalItemId, transactionId: r?.transaction_id ?? item.transactionId, errorName: r?.errors?.name ?? item.errorName },
        });
      }
      if (status === 'SUCCESS') {
        await tx.citationCredit.updateMany({ where: { payoutItemId: item.id, status: 'in_payout' }, data: { status: 'paid' } });
      } else if (FAILED.has(status) || wholeBatchFailed) {
        // Back into the pool — including a payout that had succeeded and was later returned or
        // reversed: the next batch pays it again, to the contributor's current PayPal address.
        await tx.citationCredit.updateMany({ where: { payoutItemId: item.id, status: { in: ['in_payout', 'paid'] } }, data: { status: 'accrued', payoutItemId: null } });
      }
    }
    const open = (await tx.royaltyPayoutItem.count({ where: { payoutId, status: { in: [...OPEN_ITEM] } } })) > 0;
    const keepPolling = open && Date.now() - payout.createdAt.getTime() < POLL_FOR_MS;
    const pollCount = payout.pollCount + 1;
    await tx.royaltyPayout.update({
      where: { id: payoutId },
      data: { status: batchStatus, lastCheckedAt: new Date(), pollCount, nextPollAt: keepPolling ? pollAt(pollCount) : null, pollLockedUntil: null },
    });
    if (!keepPolling && payout.nextPollAt) {
      await appendAudit(tx, { entityType: 'royalty_payout', entityId: payoutId, tenantId: payout.libraryId, eventType: 'royalties.payout_settled', payload: { batchStatus, stillOpenItems: open } });
    }
  });
  return royaltyPayoutOut(payoutId, db);
}

/** A PayPal payout webhook for a royalty batch: backfill its id if the send reply was lost, then read it back. */
export async function royaltyPayoutFromWebhook(db: Db, paypal: PayPalGateway, ids: { paypalBatchId: string | null; senderBatchId: string | null; senderItemId: string | null }): Promise<string | null> {
  let payout = ids.paypalBatchId ? await db.royaltyPayout.findUnique({ where: { paypalBatchId: ids.paypalBatchId } }) : null;
  if (!payout && ids.senderBatchId) payout = await db.royaltyPayout.findUnique({ where: { senderBatchId: ids.senderBatchId } });
  if (!payout && ids.senderItemId) payout = (await db.royaltyPayoutItem.findUnique({ where: { senderItemId: ids.senderItemId }, include: { payout: true } }))?.payout ?? null;
  if (!payout) return null;
  if (!payout.paypalBatchId && ids.paypalBatchId) {
    await db.royaltyPayout.update({ where: { id: payout.id }, data: { paypalBatchId: ids.paypalBatchId, status: 'PENDING', sendingSince: null } });
    await db.royaltyPayoutItem.updateMany({ where: { payoutId: payout.id, status: 'SUBMITTING' }, data: { status: 'PENDING' } });
  }
  const res = await refreshRoyaltyPayout(db, paypal, payout.id);
  return `royalty payout ${payout.id} refreshed → ${res.status}`;
}

async function royaltyPayoutOut(payoutId: string, db: Db | Tx) {
  const p = await db.royaltyPayout.findUniqueOrThrow({ where: { id: payoutId }, include: { items: true } });
  return { id: p.id, status: p.status, paypalBatchId: p.paypalBatchId, totalCents: p.totalCents, items: p.items.map((i) => ({ id: i.id, contributorId: i.contributorId, amountCents: i.amountCents, status: i.status })) };
}

/** A contributor's earnings from answers: every credit, and where its money is. */
export async function contributorAnswerEarnings(db: Db, contributorId: string) {
  const credits = await db.citationCredit.findMany({
    where: { contributorId },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: { answer: { select: { createdAt: true, library: { select: { name: true } } } }, payoutItem: { select: { status: true, transactionId: true } } },
  });
  const sum = (...statuses: string[]) => credits.filter((c) => statuses.includes(c.status)).reduce((n, c) => n + c.amountCents, 0);
  return {
    paidCents: sum('paid'),
    owedCents: sum('accrued', 'in_payout'),
    citations: credits.filter((c) => c.status !== 'reversed').reduce((n, c) => n + c.citations, 0),
    clearingDays: clearingDays(),
    credits: credits.map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      library: c.answer.library.name,
      assetTitle: c.assetTitle,
      citations: c.citations,
      centsPerCitation: c.centsPerCitation,
      amountCents: c.amountCents,
      status: c.status,
      payoutStatus: c.payoutItem?.status ?? null,
      transactionId: c.payoutItem?.transactionId ?? null,
    })),
  };
}
