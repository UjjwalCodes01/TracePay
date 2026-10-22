import type { Db } from '../../db';
import { logger } from '../../http/logger';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Order } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { CAPTURE_ON_BEHALF_WINDOW_MS, ORDER_ABANDON_AFTER_MS, ORDER_CHECK_DELAYS_MS, ORDER_NOT_FOUND_GRACE_MS, PENDING_CAPTURE_DELAYS_MS, PENDING_CAPTURE_GIVE_UP_MS, after, scheduled } from '../reconciliation/schedule';
import { STALE_SUBMISSION_MS } from '../settlements/settlement.service';
import { applyTopUpCapture } from './credits.service';
import { refreshRoyaltyPayout } from './royalties.service';

/**
 * Reconciliation for pay-per-citation money, run by the same worker as sales:
 *  - top-ups: a buyer can approve in PayPal and close the tab before TracePay captures,
 *    or a capture's reply can be lost; this finds out from PayPal and credits (or closes) it;
 *  - royalty batches: read back from PayPal until every payout is final.
 * Claims use a lease (FOR UPDATE SKIP LOCKED), so several instances never double-check.
 */

const LEASE_MS = 5 * 60_000;
const MAX_FAILED_CHECKS = 10;

interface Claim {
  id: string;
  lease: Date;
}

const transient = (err: unknown) => (err instanceof PayPalApiError && err.retryable) || err instanceof TypeError || (err as Error)?.name === 'TimeoutError';

async function claimTopUps(db: Db, now: Date, limit: number): Promise<Claim[]> {
  const lease = new Date(now.getTime() + LEASE_MS + Math.floor(Math.random() * 1000));
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "CreditTopUp" SET "checkLockedUntil" = ${lease}
    WHERE id IN (SELECT id FROM "CreditTopUp"
                 WHERE "nextCheckAt" <= ${now} AND ("checkLockedUntil" IS NULL OR "checkLockedUntil" < ${now})
                 ORDER BY "nextCheckAt" ASC LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return rows.map((r) => ({ id: r.id, lease }));
}

async function claimRoyaltyPayouts(db: Db, now: Date, limit: number): Promise<Claim[]> {
  const lease = new Date(now.getTime() + LEASE_MS + Math.floor(Math.random() * 1000));
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "RoyaltyPayout" SET "pollLockedUntil" = ${lease}
    WHERE id IN (SELECT id FROM "RoyaltyPayout"
                 WHERE "nextPollAt" <= ${now} AND ("pollLockedUntil" IS NULL OR "pollLockedUntil" < ${now})
                 ORDER BY "nextPollAt" ASC LIMIT ${limit}
                 FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return rows.map((r) => ({ id: r.id, lease }));
}

/** One look at a pending top-up. Returns what happened, for logs. */
export async function checkTopUp(db: Db, paypal: PayPalGateway, claim: Claim | string, now = new Date()): Promise<string> {
  const c: Claim = typeof claim === 'string' ? { id: claim, lease: new Date(0) } : claim;
  const t = await db.creditTopUp.findUnique({ where: { id: c.id }, include: { account: true } });
  if (!t) return 'gone';
  const count = t.checkCount + 1;
  const age = now.getTime() - t.createdAt.getTime();
  const release = (nextCheckAt: Date | null) =>
    db.creditTopUp.updateMany({ where: { id: t.id, OR: [{ checkLockedUntil: c.lease }, { checkLockedUntil: null }] }, data: { checkLockedUntil: null, nextCheckAt, checkCount: count } });
  const close = async (reason: string) => {
    const moved = await db.$transaction(async (tx) => {
      const res = await tx.creditTopUp.updateMany({ where: { id: t.id, status: 'pending_payment' }, data: { status: 'payment_failed', nextCheckAt: null, checkLockedUntil: null, checkCount: count } });
      if (res.count) await appendAudit(tx, { entityType: 'credit_account', entityId: t.accountId, eventType: 'credits.top_up_failed', payload: { topUpId: t.id, reason } });
      return res.count;
    });
    return moved ? `top-up ${t.id} closed: ${reason}` : `top-up ${t.id}: nothing to do`;
  };

  if (t.status !== 'pending_payment' || !t.orderId) {
    await release(null);
    return `top-up ${t.id}: ${t.status}`;
  }
  try {
    // A capture PayPal holds as PENDING: follow it until it settles either way.
    if (t.captureId) {
      const capture = await paypal.getCapture(t.captureId);
      const outcome = await applyTopUpCapture(db, t.id, { ...capture, custom_id: capture.custom_id ?? t.id }, 'reconciliation');
      const still = (await db.creditTopUp.findUniqueOrThrow({ where: { id: t.id }, select: { status: true } })).status === 'pending_payment';
      if (still && age > PENDING_CAPTURE_GIVE_UP_MS) {
        await release(null);
        logger.warn({ topUpId: t.id }, 'top-up capture still pending at PayPal after 30 days');
        return `top-up ${t.id}: still pending after 30 days — check PayPal`;
      }
      await release(still ? after(scheduled(PENDING_CAPTURE_DELAYS_MS, count)) : null);
      return outcome;
    }

    let order: Order;
    try {
      order = await paypal.getOrder(t.orderId);
    } catch (err) {
      if (err instanceof PayPalApiError && err.status === 404) {
        // PayPal forgets orders that were never completed. Only conclude after a grace period.
        if (age > ORDER_NOT_FOUND_GRACE_MS) return close('PayPal no longer has this checkout (it expired unpaid)');
        await release(after(scheduled(ORDER_CHECK_DELAYS_MS, count)));
        return `top-up ${t.id}: order not found yet`;
      }
      throw err;
    }
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (capture) {
      const outcome = await applyTopUpCapture(db, t.id, { ...capture, custom_id: capture.custom_id ?? t.id }, 'reconciliation');
      const still = (await db.creditTopUp.findUniqueOrThrow({ where: { id: t.id }, select: { status: true } })).status === 'pending_payment';
      await release(still ? after(scheduled(PENDING_CAPTURE_DELAYS_MS, 0)) : null);
      return `top-up ${t.id}: ${outcome}`;
    }
    if (order.status === 'APPROVED') {
      // The buyer approved and left before we captured. Capture for them while that is
      // clearly what they meant (same request id as our own capture: never twice).
      if (age <= CAPTURE_ON_BEHALF_WINDOW_MS) {
        const captured = await paypal.captureOrder(t.orderId, `capture-${t.id}`);
        const cap = captured.purchase_units?.[0]?.payments?.captures?.[0];
        if (!cap) {
          await release(after(scheduled(ORDER_CHECK_DELAYS_MS, count)));
          return `top-up ${t.id}: captured but no capture returned yet`;
        }
        const outcome = await applyTopUpCapture(db, t.id, { ...cap, custom_id: cap.custom_id ?? t.id }, 'reconciliation');
        const still = (await db.creditTopUp.findUniqueOrThrow({ where: { id: t.id }, select: { status: true } })).status === 'pending_payment';
        await release(still ? after(scheduled(PENDING_CAPTURE_DELAYS_MS, 0)) : null);
        return `top-up ${t.id} captured on the buyer's behalf: ${outcome}`;
      }
      // Approved long ago and never captured: PayPal releases it; the buyer was not charged.
      if (age > ORDER_ABANDON_AFTER_MS) return close('approved but never completed; PayPal released it');
      await release(after(scheduled(ORDER_CHECK_DELAYS_MS, count)));
      return `top-up ${t.id}: approved, outside the capture window`;
    }
    if (age > ORDER_ABANDON_AFTER_MS) return close('the buyer never finished paying');
    await release(after(scheduled(ORDER_CHECK_DELAYS_MS, count)));
    return `top-up ${t.id}: ${order.status.toLowerCase()}`;
  } catch (err) {
    if (!transient(err)) logger.error({ err, topUpId: t.id }, 'top-up reconciliation failed');
    if (!transient(err) && count >= MAX_FAILED_CHECKS) {
      await release(null);
      return `top-up ${t.id}: gave up after ${count} failed checks`;
    }
    await release(new Date(now.getTime() + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(count, 6))));
    return `top-up ${t.id}: check failed, will retry`;
  }
}

/** One poll of a royalty batch (refreshRoyaltyPayout schedules the next one, or stops). */
export async function pollRoyaltyPayout(db: Db, paypal: PayPalGateway, claim: Claim, now = new Date()): Promise<string> {
  try {
    const res = await refreshRoyaltyPayout(db, paypal, claim.id);
    return `royalty payout ${claim.id} → ${res.status}`;
  } catch (err) {
    if (!transient(err)) logger.error({ err, payoutId: claim.id }, 'royalty payout poll failed');
    await db.royaltyPayout.updateMany({ where: { id: claim.id, pollLockedUntil: claim.lease }, data: { pollLockedUntil: null, nextPollAt: new Date(now.getTime() + 15 * 60_000) } });
    return `royalty payout ${claim.id}: poll failed, will retry`;
  }
}

/** Everything pay-per-citation that is due. Also turns sends a crash interrupted into resendable batches. */
export async function reconcileAnswersDue(db: Db, paypal: PayPalGateway, now: () => Date, limit: number, go: () => boolean): Promise<{ topUps: number; royaltyPayouts: number; outcomes: string[] }> {
  const result = { topUps: 0, royaltyPayouts: 0, outcomes: [] as string[] };
  const interrupted = await db.royaltyPayout.updateMany({
    where: { status: 'SUBMITTING', paypalBatchId: null, sendingSince: { lt: new Date(now().getTime() - STALE_SUBMISSION_MS * 5) } },
    data: { status: 'SUBMIT_FAILED', sendingSince: null },
  });
  if (interrupted.count) result.outcomes.push(`${interrupted.count} interrupted royalty send(s) can be sent again`);
  while (result.topUps < limit && go()) {
    const claims = await claimTopUps(db, now(), Math.min(3, limit - result.topUps));
    if (!claims.length) break;
    result.topUps += claims.length;
    result.outcomes.push(...(await Promise.all(claims.map((c) => checkTopUp(db, paypal, c, now())))));
  }
  while (result.royaltyPayouts < limit && go()) {
    const claims = await claimRoyaltyPayouts(db, now(), Math.min(3, limit - result.royaltyPayouts));
    if (!claims.length) break;
    result.royaltyPayouts += claims.length;
    result.outcomes.push(...(await Promise.all(claims.map((c) => pollRoyaltyPayout(db, paypal, c, now())))));
  }
  return result;
}

/** When pay-per-citation next needs a look (null = nothing scheduled). */
export async function nextAnswersReconcileAt(db: Db, now = new Date()): Promise<Date | null> {
  const [topUp, payout] = await Promise.all([
    db.creditTopUp.findFirst({ where: { nextCheckAt: { not: null } }, orderBy: { nextCheckAt: 'asc' }, select: { nextCheckAt: true, checkLockedUntil: true } }),
    db.royaltyPayout.findFirst({ where: { nextPollAt: { not: null } }, orderBy: { nextPollAt: 'asc' }, select: { nextPollAt: true, pollLockedUntil: true } }),
  ]);
  const times = [
    topUp ? Math.max(topUp.nextCheckAt!.getTime(), topUp.checkLockedUntil && topUp.checkLockedUntil > now ? topUp.checkLockedUntil.getTime() : 0) : null,
    payout ? Math.max(payout.nextPollAt!.getTime(), payout.pollLockedUntil && payout.pollLockedUntil > now ? payout.pollLockedUntil.getTime() : 0) : null,
  ].filter((t): t is number => t !== null);
  return times.length ? new Date(Math.min(...times)) : null;
}
