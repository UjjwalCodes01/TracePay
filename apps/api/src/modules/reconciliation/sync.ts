import type { Db } from '../../db';
import { logger } from '../../http/logger';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Order } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { applyCapture, captureSale, declineCapture, markSaleReversed, PaymentError } from '../payments/payments.service';
import { PAYOUT_STUCK_AFTER_MS, pollDelay, refreshBatch, SettlementStateError, STALE_SUBMISSION_MS, submitPayouts } from '../settlements/settlement.service';
import { openIssue, saleOwner } from './issues';
import {
  after, CAPTURE_ON_BEHALF_WINDOW_MS, nextRefundCheck, ORDER_ABANDON_AFTER_MS, ORDER_CHECK_DELAYS_MS, ORDER_NOT_FOUND_GRACE_MS,
  PENDING_CAPTURE_DELAYS_MS, PENDING_CAPTURE_GIVE_UP_MS, RESEND_SAFE_FOR_MS, scheduled,
} from './schedule';

/**
 * Reconciliation: TracePay asks PayPal itself instead of relying only on
 * webhooks (which can be missed — a sleeping server, a PayPal outage, a
 * misconfigured webhook). Every in-flight payment and payout batch carries the
 * time of its next check; a worker claims due ones with a lease (a token it alone
 * may release) and acts on what PayPal reports, through the same idempotent
 * operations as everything else. Every schedule ends: in a final state, or with a
 * "needs attention" issue.
 */

/** Long enough for the slowest check (a couple of PayPal calls with their own retries). */
const LEASE_MS = 5 * 60_000;
/** A batch PayPal accepted but whose id never arrived: tell a person after this long. */
export const UNCONFIRMED_AFTER_MS = 60 * 60_000;
/** Non-transient errors on the same payment this many times: stop and tell a person. */
const MAX_FAILED_CHECKS = 10;
/** Items processed (and claimed) together. */
const CHUNK = 3;

/** Errors worth trying again later (PayPal or the network having a moment). */
const transient = (err: unknown) =>
  (err instanceof PayPalApiError && err.retryable) || err instanceof TypeError || (err as Error)?.name === 'TimeoutError' ||
  (err instanceof PaymentError && err.code === 'provider');

interface Claim {
  id: string;
  lease: Date;
}

// ---- payout batches -----------------------------------------------------------------------

export async function claimDueBatches(db: Db, now: Date, limit: number, onlyIds?: string[]): Promise<Claim[]> {
  // Unique to this claim (ms precision is stored): releases are WHERE lease = mine.
  const lease = new Date(now.getTime() + LEASE_MS + Math.floor(Math.random() * 1000));
  const rows = onlyIds
    ? await db.$queryRaw<{ id: string }[]>`
        UPDATE "PayoutBatch" SET "pollLockedUntil" = ${lease}
        WHERE id IN (SELECT id FROM "PayoutBatch"
                     WHERE id = ANY(${onlyIds}) AND "nextPollAt" IS NOT NULL AND ("pollLockedUntil" IS NULL OR "pollLockedUntil" < ${now})
                     LIMIT ${limit}
                     FOR UPDATE SKIP LOCKED)
        RETURNING id`
    : await db.$queryRaw<{ id: string }[]>`
        UPDATE "PayoutBatch" SET "pollLockedUntil" = ${lease}
        WHERE id IN (SELECT id FROM "PayoutBatch"
                     WHERE "nextPollAt" <= ${now} AND ("pollLockedUntil" IS NULL OR "pollLockedUntil" < ${now})
                     ORDER BY "nextPollAt" ASC LIMIT ${limit}
                     FOR UPDATE SKIP LOCKED)
        RETURNING id`;
  return rows.map((r) => ({ id: r.id, lease }));
}

/** One reconciliation step for a payout batch. Returns what happened, for logs and the API. */
export async function pollPayoutBatch(db: Db, paypal: PayPalGateway, claim: Claim | string, now = new Date()): Promise<string> {
  const c: Claim = typeof claim === 'string' ? { id: claim, lease: new Date(0) } : claim;
  const batch = await db.payoutBatch.findUnique({
    where: { id: c.id },
    select: { id: true, runId: true, status: true, paypalBatchId: true, pollCount: true, createdAt: true, updatedAt: true, sendingSince: true, attempt: true, run: { select: { saleId: true } } },
  });
  if (!batch) return 'gone';
  const nextCount = batch.pollCount + 1;
  const age = now.getTime() - batch.createdAt.getTime();
  /** Only while we still hold the lease (a slower worker can't undo a newer one's result). */
  const release = (nextPollAt: Date | null) =>
    db.payoutBatch.updateMany({ where: { id: batch.id, pollLockedUntil: c.lease }, data: { pollLockedUntil: null, nextPollAt, pollCount: nextCount } });
  const stuck = async (kind: 'payout_stuck' | 'check_stuck') => {
    const owner = await saleOwner(db, batch.run.saleId);
    if (owner) await db.$transaction((tx) => openIssue(tx, { ownerId: owner.ownerId, kind, subjectType: 'payout_batch', subjectId: batch.id, artifactId: owner.artifactId, data: { attempt: batch.attempt } }));
  };

  try {
    // Accepted by PayPal: read the real statuses (refreshBatch schedules the next poll or stops).
    if (batch.paypalBatchId) {
      await refreshBatch(db, paypal, batch.id, { pollCount: nextCount });
      await db.payoutBatch.updateMany({ where: { id: batch.id, pollLockedUntil: c.lease }, data: { pollLockedUntil: null } });
      return 'refreshed';
    }
    // A send that was interrupted (the process died mid-request): finish it with the SAME
    // sender_batch_id, so PayPal can't pay twice — but only while PayPal still remembers it.
    if (batch.status === 'SUBMITTING') {
      const since = batch.sendingSince ?? batch.updatedAt;
      if (now.getTime() - since.getTime() < STALE_SUBMISSION_MS) {
        await release(new Date(since.getTime() + STALE_SUBMISSION_MS + 60_000));
        return 'still sending';
      }
      if (age > RESEND_SAFE_FOR_MS) {
        await stuck('payout_stuck');
        await release(null);
        return 'too old to resend safely';
      }
      await submitPayouts(db, paypal, batch.runId).catch((err) => {
        if (!(err instanceof SettlementStateError)) throw err;
      });
      const sent = await db.payoutBatch.findUniqueOrThrow({ where: { id: batch.id }, select: { status: true } });
      // sendBatch scheduled the next poll if PayPal took it; otherwise a person decides (issue opened there).
      await db.payoutBatch.updateMany({ where: { id: batch.id, pollLockedUntil: c.lease }, data: { pollLockedUntil: null, pollCount: nextCount } });
      return `resubmitted → ${sent.status}`;
    }
    // PayPal has it, but its id never reached us: only its webhook can bring it.
    if (batch.status === 'AWAITING_CONFIRMATION') {
      if (age >= UNCONFIRMED_AFTER_MS) {
        const owner = await saleOwner(db, batch.run.saleId);
        if (owner) {
          await db.$transaction((tx) =>
            openIssue(tx, { ownerId: owner.ownerId, kind: 'payout_unconfirmed', subjectType: 'payout_batch', subjectId: batch.id, artifactId: owner.artifactId, data: { attempt: batch.attempt } }),
          );
        }
      }
      await release(age >= PAYOUT_STUCK_AFTER_MS ? null : new Date(now.getTime() + 60 * 60_000));
      return 'awaiting confirmation';
    }
    // SUBMIT_FAILED (an issue was opened when it failed) and anything else: a person decides.
    await release(null);
    return `nothing to poll (${batch.status})`;
  } catch (err) {
    if (!transient(err)) logger.error({ err, batchId: batch.id }, 'payout reconciliation failed');
    // Back off; and never forever.
    if (age > PAYOUT_STUCK_AFTER_MS) {
      await stuck('check_stuck').catch(() => undefined);
      await release(null).catch(() => undefined);
    } else {
      await release(new Date(now.getTime() + pollDelay(nextCount))).catch(() => undefined);
    }
    return `error: ${(err as Error).message}`;
  }
}

// ---- payments -----------------------------------------------------------------------------

export async function claimDuePayments(db: Db, now: Date, limit: number, onlyIds?: string[]): Promise<Claim[]> {
  const lease = new Date(now.getTime() + LEASE_MS + Math.floor(Math.random() * 1000));
  const rows = onlyIds
    ? await db.$queryRaw<{ id: string }[]>`
        UPDATE "PayPalPayment" SET "checkLockedUntil" = ${lease}
        WHERE id IN (SELECT id FROM "PayPalPayment"
                     WHERE id = ANY(${onlyIds}) AND "nextCheckAt" IS NOT NULL AND ("checkLockedUntil" IS NULL OR "checkLockedUntil" < ${now})
                     LIMIT ${limit}
                     FOR UPDATE SKIP LOCKED)
        RETURNING id`
    : await db.$queryRaw<{ id: string }[]>`
        UPDATE "PayPalPayment" SET "checkLockedUntil" = ${lease}
        WHERE id IN (SELECT id FROM "PayPalPayment"
                     WHERE "nextCheckAt" <= ${now} AND ("checkLockedUntil" IS NULL OR "checkLockedUntil" < ${now})
                     ORDER BY "nextCheckAt" ASC LIMIT ${limit}
                     FOR UPDATE SKIP LOCKED)
        RETURNING id`;
  return rows.map((r) => ({ id: r.id, lease }));
}

/** A checkout that will never complete: the buyer wasn't charged. */
async function expireCheckout(db: Db, saleId: string, reason: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
    const moved = await tx.sale.updateMany({ where: { id: saleId, status: 'pending_payment' }, data: { status: 'payment_failed' } });
    // Only if it was still open: a sale the buyer completed meanwhile keeps its refund watch.
    if (!moved.count) return false;
    await tx.payPalPayment.update({ where: { saleId }, data: { nextCheckAt: null } });
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, select: { artifactId: true } });
    await appendAudit(tx, { entityType: 'sale', entityId: saleId, artifactId: sale.artifactId, eventType: 'sale.checkout_expired', payload: { reason } });
    return true;
  });
}

/** Is it safe to capture this approved order on the buyer's behalf right now? (Never risk a double charge.) */
async function mayCaptureOnBehalf(db: Db, sale: { id: string; artifactId: string; buyerId: string | null; createdAt: Date }, now: Date): Promise<string | null> {
  // Within this window a new checkout by the same buyer reuses THIS order — after it, the
  // buyer may already be paying through a new one.
  if (now.getTime() - sale.createdAt.getTime() > CAPTURE_ON_BEHALF_WINDOW_MS) return 'The buyer approved but didn’t finish in time; the checkout was closed without charging.';
  const artifact = await db.artifact.findUnique({ where: { id: sale.artifactId }, select: { status: true } });
  if (artifact?.status !== 'listed') return 'The report is no longer for sale, so the payment was not taken.';
  if (sale.buyerId) {
    const other = await db.sale.count({
      where: { artifactId: sale.artifactId, buyerId: sale.buyerId, id: { not: sale.id }, OR: [{ status: 'captured' }, { createdAt: { gt: sale.createdAt } }] },
    });
    if (other) return 'The buyer bought or started buying this report through another checkout.';
  }
  return null;
}

/** One reconciliation step for a payment. */
export async function checkPayment(db: Db, paypal: PayPalGateway, claim: Claim | string, now = new Date()): Promise<string> {
  const c: Claim = typeof claim === 'string' ? { id: claim, lease: new Date(0) } : claim;
  const p = await db.payPalPayment.findUnique({
    where: { id: c.id },
    select: {
      id: true, saleId: true, orderId: true, orderStatus: true, captureId: true, captureStatus: true, capturedCents: true, checkCount: true, createdAt: true,
      sale: { select: { id: true, status: true, artifactId: true, buyerId: true, createdAt: true } },
    },
  });
  if (!p) return 'gone';
  const nextCount = p.checkCount + 1;
  const age = now.getTime() - p.createdAt.getTime();
  /**
   * Schedules the next check — only if nothing else changed the payment meanwhile (a
   * capture, a refund, the buyer finishing): their schedule must win over ours.
   */
  const reschedule = (nextCheckAt: Date | null, extra: { orderStatus?: string } = {}) =>
    db.payPalPayment.updateMany({
      where: { id: p.id, checkCount: p.checkCount, captureId: p.captureId, sale: { status: p.sale.status } },
      data: { nextCheckAt, checkCount: nextCount, ...extra },
    });
  const tellPerson = async () => {
    const owner = await saleOwner(db, p.saleId);
    if (owner) await db.$transaction((tx) => openIssue(tx, { ownerId: owner.ownerId, kind: 'check_stuck', subjectType: 'sale', subjectId: p.saleId, artifactId: owner.artifactId, data: {} }));
  };

  try {
    if (p.sale.status === 'pending_payment' && !p.captureId) {
      // A checkout that hasn't come back to us.
      let order: Order;
      try {
        order = await paypal.getOrder(p.orderId);
      } catch (err) {
        if (err instanceof PayPalApiError && err.status === 404) {
          // "Not found" can be a PayPal hiccup: close it only well past the order's
          // lifetime AND after a second "not found" on a later check.
          if (age >= ORDER_NOT_FOUND_GRACE_MS && p.orderStatus === 'NOT_FOUND') {
            await expireCheckout(db, p.saleId, 'PayPal no longer has this order (it expired).');
            return 'expired (order gone)';
          }
          await reschedule(after(scheduled(ORDER_CHECK_DELAYS_MS, nextCount), now), { orderStatus: 'NOT_FOUND' });
          return 'order not found (will check again)';
        }
        throw err;
      }
      if (order.status === 'APPROVED') {
        const refusal = await mayCaptureOnBehalf(db, p.sale, now);
        if (refusal) {
          await expireCheckout(db, p.saleId, refusal);
          return `not captured: ${refusal}`;
        }
        // The buyer approved, then the page never captured (closed tab, lost connection).
        // captureSale re-checks the licenses (and ownership) first and is idempotent with
        // the buyer's own attempt.
        try {
          const outcome = await captureSale(db, paypal, p.saleId);
          return `captured on the buyer's behalf → ${outcome.saleStatus}`;
        } catch (err) {
          if (!(err instanceof PaymentError) || err.code === 'provider') throw err;
          // Not capturable right now (a race with the buyer, or a check refused it). If the
          // sale is still open, look again later — never spin.
          const still = await db.sale.findUnique({ where: { id: p.saleId }, select: { status: true } });
          if (still?.status === 'pending_payment') await reschedule(after(scheduled(ORDER_CHECK_DELAYS_MS, nextCount), now));
          return `not captured: ${err.message}`;
        }
      }
      if (order.status === 'COMPLETED') {
        const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
        if (capture) {
          const outcome = await applyCapture(db, p.saleId, order, capture, 'reconciliation');
          return `capture recorded → ${outcome.saleStatus}`;
        }
      }
      if (order.status === 'VOIDED' || age >= ORDER_ABANDON_AFTER_MS) {
        await expireCheckout(db, p.saleId, order.status === 'VOIDED' ? 'PayPal voided the order.' : 'The buyer never completed the checkout.');
        return 'expired (abandoned)';
      }
      await reschedule(after(scheduled(ORDER_CHECK_DELAYS_MS, nextCount), now), { orderStatus: order.status });
      return `waiting for the buyer (${order.status})`;
    }

    if (p.sale.status === 'pending_payment' && p.captureId) {
      // A capture PayPal is holding (e.g. an eCheck).
      const capture = await paypal.getCapture(p.captureId);
      if (capture.status === 'COMPLETED') {
        const outcome = await applyCapture(db, p.saleId, null, capture, 'reconciliation');
        return `pending capture completed → ${outcome.saleStatus}`;
      }
      if (capture.status === 'DECLINED' || capture.status === 'FAILED') {
        await declineCapture(db, p.saleId, capture);
        return `pending capture ${capture.status.toLowerCase()}`;
      }
      if (capture.status === 'PENDING') {
        if (age > PENDING_CAPTURE_GIVE_UP_MS) {
          await tellPerson();
          await reschedule(null);
          return 'capture pending too long';
        }
        await reschedule(after(scheduled(PENDING_CAPTURE_DELAYS_MS, nextCount), now));
        return 'capture still pending';
      }
      const outcome = await applyCapture(db, p.saleId, null, capture, 'reconciliation');
      return `capture ${capture.status} → ${outcome.saleStatus}`;
    }

    if ((p.sale.status === 'captured' || p.sale.status === 'exception') && p.captureId) {
      // A completed (or partly refunded) sale: was it refunded directly in PayPal?
      const capture = await paypal.getCapture(p.captureId);
      const full = capture.status === 'REFUNDED';
      const partial = capture.status === 'PARTIALLY_REFUNDED';
      if (full || (partial && p.sale.status === 'captured')) {
        await db.$transaction((tx) =>
          markSaleReversed(tx, { captureId: p.captureId!, saleIdHint: p.saleId, eventType: 'PAYMENT.CAPTURE.REFUNDED', refundedCents: full ? p.capturedCents : null, partial }),
        );
        return partial ? 'partial refund found' : 'refund found';
      }
      // Fixed points after the sale (manual checks never use the schedule up).
      await reschedule(nextRefundCheck(p.createdAt, now));
      return p.sale.status === 'captured' ? 'still captured' : 'no further refund';
    }

    // Refunded, failed…: a person (or nothing) takes it from here.
    await reschedule(null);
    return `nothing to check (${p.sale.status})`;
  } catch (err) {
    if (!transient(err)) logger.error({ err, paymentId: p.id }, 'payment reconciliation failed');
    if (!transient(err) && nextCount >= MAX_FAILED_CHECKS) {
      await tellPerson().catch(() => undefined);
      await reschedule(null).catch(() => undefined);
    } else {
      await reschedule(after(scheduled(ORDER_CHECK_DELAYS_MS, nextCount), now)).catch(() => undefined);
    }
    return `error: ${(err as Error).message}`;
  } finally {
    // It was checked now; and release the lease — only if it is still ours.
    await db.payPalPayment.updateMany({ where: { id: p.id }, data: { lastCheckedAt: now } }).catch(() => undefined);
    await db.payPalPayment.updateMany({ where: { id: p.id, checkLockedUntil: c.lease }, data: { checkLockedUntil: null } }).catch(() => undefined);
  }
}

// ---- passes ---------------------------------------------------------------------------------

export interface PassResult {
  batches: number;
  payments: number;
  outcomes: string[];
}

/**
 * Processes what is due (or, with `only`, exactly these items). Claims a few at a
 * time, so a lease never runs out while its item waits behind slow ones.
 */
export async function reconcileDue(
  db: Db,
  paypal: PayPalGateway,
  opts: { now?: () => Date; limit?: number; only?: { batchIds: string[]; paymentIds: string[] }; shouldContinue?: () => boolean } = {},
): Promise<PassResult> {
  const now = opts.now ?? (() => new Date());
  const limit = opts.limit ?? 30;
  const result: PassResult = { batches: 0, payments: 0, outcomes: [] };
  const go = () => !opts.shouldContinue || opts.shouldContinue();
  const only = opts.only ? { batchIds: [...opts.only.batchIds], paymentIds: [...opts.only.paymentIds] } : undefined;

  while (result.batches < limit && go() && (!only || only.batchIds.length)) {
    const claims = await claimDueBatches(db, now(), Math.min(CHUNK, limit - result.batches), only?.batchIds);
    if (!claims.length) break;
    result.batches += claims.length;
    result.outcomes.push(...(await Promise.all(claims.map((c) => pollPayoutBatch(db, paypal, c, now())))));
    if (only) only.batchIds = only.batchIds.filter((id) => !claims.some((c) => c.id === id));
  }
  while (result.payments < limit && go() && (!only || only.paymentIds.length)) {
    const claims = await claimDuePayments(db, now(), Math.min(CHUNK, limit - result.payments), only?.paymentIds);
    if (!claims.length) break;
    result.payments += claims.length;
    result.outcomes.push(...(await Promise.all(claims.map((c) => checkPayment(db, paypal, c, now())))));
    if (only) only.paymentIds = only.paymentIds.filter((id) => !claims.some((c) => c.id === id));
  }
  return result;
}

/** When something next needs checking (leased items count from their lease expiry). */
export async function nextReconcileAt(db: Db, now = new Date()): Promise<Date | null> {
  const [batch, payment] = await Promise.all([
    db.payoutBatch.findFirst({ where: { nextPollAt: { not: null } }, orderBy: { nextPollAt: 'asc' }, select: { nextPollAt: true, pollLockedUntil: true } }),
    db.payPalPayment.findFirst({ where: { nextCheckAt: { not: null } }, orderBy: { nextCheckAt: 'asc' }, select: { nextCheckAt: true, checkLockedUntil: true } }),
  ]);
  const times = [
    batch ? Math.max(batch.nextPollAt!.getTime(), batch.pollLockedUntil && batch.pollLockedUntil > now ? batch.pollLockedUntil.getTime() : 0) : null,
    payment ? Math.max(payment.nextCheckAt!.getTime(), payment.checkLockedUntil && payment.checkLockedUntil > now ? payment.checkLockedUntil.getTime() : 0) : null,
  ].filter((t): t is number => t !== null);
  return times.length ? new Date(Math.min(...times)) : null;
}

/** "Check with PayPal now" for one publisher: everything of theirs still in flight, right away. */
export async function reconcileOwnerNow(db: Db, paypal: PayPalGateway, ownerId: string): Promise<PassResult> {
  const owned = { sale: { artifact: { buildJob: { publisherId: ownerId } } } };
  const [batches, payments] = await Promise.all([
    db.payoutBatch.findMany({ where: { nextPollAt: { not: null }, run: owned }, select: { id: true }, take: 25 }),
    db.payPalPayment.findMany({ where: { nextCheckAt: { not: null }, ...owned }, select: { id: true }, take: 25 }),
  ]);
  return reconcileDue(db, paypal, { only: { batchIds: batches.map((b) => b.id), paymentIds: payments.map((p) => p.id) }, limit: 25 });
}

/**
 * Runs reconciliation in the background, like the webhook dispatcher: it sleeps
 * until the next scheduled check (so an idle deployment lets Neon suspend), wakes
 * when something new is scheduled or the API is used, never spins, and is safe on
 * several instances.
 */
export class ReconciliationWorker {
  private timer: NodeJS.Timeout | null = null;
  private dueAt = Infinity;
  private stopped = false;
  private failures = 0;
  private current: Promise<void> | null = null;
  private lastKick = 0;

  constructor(private readonly deps: () => { db: Db; paypal: PayPalGateway } | null) {}

  /** Signed-in activity: run a pass soon. Throttled only while a pass is already coming up. */
  kick(): void {
    if (this.timer && Date.now() - this.lastKick < 60_000) return;
    this.lastKick = Date.now();
    this.schedule(2_000);
  }

  /** Something was scheduled for `at` (a checkout, a payout…): make sure we're awake then. */
  scheduledFor(at: Date): void {
    this.schedule(at.getTime() - Date.now() + 1_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    const delay = Math.min(Math.max(1_000, delayMs), 2_147_000_000);
    const at = Date.now() + delay;
    if (this.timer && at >= this.dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dueAt = Infinity;
      // One pass at a time; a timer firing during a pass just asks for another one after it.
      if (this.current) {
        this.schedule(1_000);
        return;
      }
      this.current = this.pass().finally(() => {
        this.current = null;
      });
    }, delay);
    this.timer.unref();
  }

  private async pass() {
    if (this.stopped) return;
    const deps = this.deps();
    if (!deps) return; // PayPal isn't configured: nothing to reconcile against.
    try {
      const result = await reconcileDue(deps.db, deps.paypal, { shouldContinue: () => !this.stopped });
      if (result.batches || result.payments) logger.info(result, 'reconciliation pass');
      this.failures = 0;
      const next = await nextReconcileAt(deps.db);
      if (next) this.schedule(next.getTime() - Date.now());
    } catch (err) {
      this.failures += 1;
      if (this.failures <= 3) logger.error({ err }, 'reconciliation pass failed');
      this.schedule(Math.min(60_000 * 2 ** (this.failures - 1), 60 * 60_000));
    }
  }
}
