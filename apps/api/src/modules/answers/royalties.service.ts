import { randomBytes } from 'node:crypto';
import { centsToDecimal } from '@tracepay/shared';
import type { Db } from '../../db';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { PayoutBatchStatus } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { SettlementStateError } from '../settlements/settlement.service';

/**
 * Paying contributors what answers earned them. Citations are worth cents, so
 * credits accrue and are paid in one PayPal Payouts batch per contributor total,
 * once it's worth sending. sender_batch_id is fixed before sending, so a resend
 * after a lost response can never pay twice.
 */

export const royaltyMinimumCents = () => {
  const n = Number(process.env.ROYALTY_PAYOUT_MIN_CENTS);
  if (Number.isInteger(n) && n >= 1) return n;
  return process.env.DEMO_MODE === 'true' ? 1 : 100;
};

const FAILED = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED']);
const FINAL_BATCH = new Set(['SUCCESS', 'DENIED', 'CANCELED']);

export async function royaltySummary(db: Db, libraryId: string) {
  const [accrued, payouts, totals] = await Promise.all([
    db.citationCredit.groupBy({ by: ['contributorId'], where: { libraryId, status: 'accrued' }, _sum: { amountCents: true, citations: true }, _count: { _all: true } }),
    db.royaltyPayout.findMany({ where: { libraryId }, orderBy: { createdAt: 'desc' }, take: 20, include: { items: true } }),
    db.answer.aggregate({ where: { libraryId, status: 'answered' }, _count: { _all: true }, _sum: { chargedCents: true, feeCents: true } }),
  ]);
  const people = await db.user.findMany({
    where: { id: { in: [...new Set([...accrued.map((a) => a.contributorId), ...payouts.flatMap((p) => p.items.map((i) => i.contributorId))])] } },
    select: { id: true, name: true, paypalEmail: true },
  });
  const who = new Map(people.map((p) => [p.id, p]));
  const minimum = royaltyMinimumCents();
  return {
    minimumCents: minimum,
    answers: totals._count._all,
    revenueCents: totals._sum.chargedCents ?? 0,
    feesCents: totals._sum.feeCents ?? 0,
    accrued: accrued
      .map((a) => ({
        contributorId: a.contributorId,
        name: who.get(a.contributorId)?.name ?? a.contributorId,
        hasPayee: !!who.get(a.contributorId)?.paypalEmail,
        amountCents: a._sum.amountCents ?? 0,
        citations: a._sum.citations ?? 0,
        answers: a._count._all,
        payable: !!who.get(a.contributorId)?.paypalEmail && (a._sum.amountCents ?? 0) >= minimum,
      }))
      .sort((x, y) => y.amountCents - x.amountCents),
    payouts: payouts.map((p) => ({
      id: p.id,
      status: p.status,
      totalCents: p.totalCents,
      paypalBatchId: p.paypalBatchId,
      createdAt: p.createdAt,
      lastCheckedAt: p.lastCheckedAt,
      items: p.items.map((i) => ({ id: i.id, name: who.get(i.contributorId)?.name ?? i.contributorId, amountCents: i.amountCents, status: i.status, transactionId: i.transactionId, errorName: i.errorName })),
    })),
  };
}

/** Groups every payable accrued credit into one Payouts batch, then sends it. */
export async function sendRoyaltyPayout(db: Db, paypal: PayPalGateway, libraryId: string) {
  if (!(await paypal.hasPayoutsScope())) throw new SettlementStateError('This PayPal app does not have the Payouts permission.', 'payouts_unavailable');
  const minimum = royaltyMinimumCents();
  const payoutId = await db.$transaction(async (tx) => {
    // Lock this library's unpaid credits: a credit can be in one batch only.
    const rows = await tx.$queryRaw<Array<{ id: string; contributorId: string; amountCents: number }>>`
      SELECT id, "contributorId", "amountCents" FROM "CitationCredit" WHERE "libraryId" = ${libraryId} AND status = 'accrued' FOR UPDATE`;
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
    const payable = [...groups].filter(([, g]) => g.total >= minimum);
    if (payable.length === 0) throw new SettlementStateError('Nothing is ready to pay yet: no contributor has reached the payout minimum.');

    const batchKey = randomBytes(8).toString('hex');
    const payout = await tx.royaltyPayout.create({
      data: { libraryId, senderBatchId: `royalties_${batchKey}`, status: 'SUBMITTING', totalCents: payable.reduce((n, [, g]) => n + g.total, 0) },
    });
    for (const [n, [contributorId, g]] of payable.entries()) {
      const item = await tx.royaltyPayoutItem.create({
        data: { payoutId: payout.id, senderItemId: `royalties_${batchKey}_${n + 1}`, contributorId, receiver: email.get(contributorId)!, amountCents: g.total },
      });
      await tx.citationCredit.updateMany({ where: { id: { in: g.ids } }, data: { status: 'in_payout', payoutItemId: item.id } });
    }
    await appendAudit(tx, { entityType: 'royalty_payout', entityId: payout.id, tenantId: libraryId, eventType: 'royalties.payout_created', payload: { totalCents: payout.totalCents, contributors: payable.length } });
    return payout.id;
  });
  return submitRoyaltyPayout(db, paypal, payoutId);
}

/** Sends (or re-sends, with the same sender_batch_id) a batch PayPal hasn't accepted yet. */
export async function submitRoyaltyPayout(db: Db, paypal: PayPalGateway, payoutId: string) {
  const payout = await db.royaltyPayout.findUniqueOrThrow({ where: { id: payoutId }, include: { items: true } });
  if (payout.paypalBatchId) return royaltyPayoutOut(payoutId, db);
  try {
    const res = await paypal.createPayoutBatch({
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
    await db.royaltyPayout.update({ where: { id: payoutId }, data: { paypalBatchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status } });
    await db.royaltyPayoutItem.updateMany({ where: { payoutId }, data: { status: 'PENDING' } });
  } catch (err) {
    // Safe to resend later: PayPal refuses a second batch with the same sender_batch_id.
    await db.royaltyPayout.update({ where: { id: payoutId }, data: { status: 'SUBMIT_FAILED' } });
    throw new SettlementStateError(`PayPal didn’t accept the payout batch: ${(err as Error).message}. Try sending it again.`, 'provider');
  }
  return royaltyPayoutOut(payoutId, db);
}

/** Reads the batch back from PayPal. Paid credits are final; failed ones return to the pool for the next batch. */
export async function refreshRoyaltyPayout(db: Db, paypal: PayPalGateway, payoutId: string) {
  const payout = await db.royaltyPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (!payout.paypalBatchId) return royaltyPayoutOut(payoutId, db);
  const remote: PayoutBatchStatus = await paypal.getPayoutBatch(payout.paypalBatchId);
  const batchStatus = remote.batch_header.batch_status;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RoyaltyPayout" WHERE id = ${payoutId} FOR UPDATE`;
    const items = await tx.royaltyPayoutItem.findMany({ where: { payoutId } });
    const remoteBySender = new Map((remote.items ?? []).map((r) => [r.payout_item.sender_item_id, r]));
    const wholeBatchFailed = batchStatus === 'DENIED' || batchStatus === 'CANCELED';
    for (const item of items) {
      const r = remoteBySender.get(item.senderItemId);
      const status = r?.transaction_status ?? (wholeBatchFailed ? batchStatus : item.status);
      if (status === item.status && !r) continue;
      await tx.royaltyPayoutItem.update({
        where: { id: item.id },
        data: { status, paypalItemId: r?.payout_item_id ?? item.paypalItemId, transactionId: r?.transaction_id ?? item.transactionId, errorName: r?.errors?.name ?? item.errorName },
      });
      if (status === 'SUCCESS') {
        await tx.citationCredit.updateMany({ where: { payoutItemId: item.id, status: 'in_payout' }, data: { status: 'paid' } });
      } else if (FAILED.has(status) || wholeBatchFailed) {
        // Back into the pool: the next batch pays them (to the contributor's current PayPal address).
        await tx.citationCredit.updateMany({ where: { payoutItemId: item.id, status: 'in_payout' }, data: { status: 'accrued', payoutItemId: null } });
      }
    }
    await tx.royaltyPayout.update({ where: { id: payoutId }, data: { status: batchStatus, lastCheckedAt: new Date() } });
    if (FINAL_BATCH.has(batchStatus) && payout.status !== batchStatus) {
      await appendAudit(tx, { entityType: 'royalty_payout', entityId: payoutId, tenantId: payout.libraryId, eventType: 'royalties.payout_settled', payload: { batchStatus } });
    }
  });
  return royaltyPayoutOut(payoutId, db);
}

async function royaltyPayoutOut(payoutId: string, db: Db) {
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
  const sum = (status: string) => credits.filter((c) => c.status === status).reduce((n, c) => n + c.amountCents, 0);
  return {
    paidCents: sum('paid'),
    owedCents: sum('accrued') + sum('in_payout'),
    citations: credits.reduce((n, c) => n + c.citations, 0),
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
