import { randomBytes } from 'node:crypto';
import { centsToDecimal, decimalToCents } from '@tracepay/shared';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Capture, Order } from '../../integrations/paypal/types';
import { appendAudit, lockAuditChain } from '../audit/audit-log';
import { after, notifyScheduled, ORDER_CHECK_DELAYS_MS, PENDING_CAPTURE_DELAYS_MS } from '../reconciliation/schedule';
import { PaymentError } from '../payments/payments.service';
import { DEMO_CREDIT_CENTS } from '../demo/soft-reset';
import { demoRoleOf } from '../demo/world';

/**
 * Prepaid answer credits, bought with PayPal. Money enters only through a
 * server-verified PayPal capture; the balance is a ledger (entries sum to it).
 */

/**
 * PayPal takes 3.49% + $0.49 per checkout (US): 13% of a $5 top-up, 6% of $20. So top-ups start at
 * $5, the app suggests $10–$50, and answers then spend that credit cent by cent with no PayPal fee.
 */
export const TOP_UP_AMOUNTS_CENTS = [1000, 2000, 5000] as const;
export const MIN_TOP_UP_CENTS = 500;
export const MAX_TOP_UP_CENTS = 10_000;

export class CreditError extends Error {
  constructor(
    message: string,
    readonly code: 'insufficient_credit' | 'not_found' | 'invalid',
  ) {
    super(message);
    this.name = 'CreditError';
  }
}

export const TOP_UP_PREFIX = 'topup_';
export const isTopUpId = (id: string | null | undefined): id is string => !!id && id.startsWith(TOP_UP_PREFIX);

export async function accountFor(tx: Tx, ownerId: string) {
  return tx.creditAccount.upsert({ where: { ownerId }, update: {}, create: { ownerId } });
}

/** Locks the account row: every balance change and reservation goes through here. */
export async function lockAccount(tx: Tx, ownerId: string) {
  await accountFor(tx, ownerId);
  await tx.$queryRaw`SELECT id FROM "CreditAccount" WHERE "ownerId" = ${ownerId} FOR UPDATE`;
  return tx.creditAccount.findUniqueOrThrow({ where: { ownerId } });
}

/** A demo buyer persona (the shared one, or a private world's). */
export const isDemoBuyer = (userId: string) => demoRoleOf(userId) === 'buyer';
/** The shared demo buyer's credit tops back up to its starting amount once less than this is left. */
export const DEMO_REFILL_BELOW_CENTS = 50;

/**
 * A hosted demo (DEMO_SHARED_BUYER): every visitor shares the demo buyer, so its demo credit
 * tops itself back up instead of running dry for the next visitor. It stays demo credit — it only
 * ever pays the demo's own contributors — and the ledger still sums to the balance.
 */
export async function refillDemoCredit(db: Db, ownerId: string): Promise<void> {
  if (!isDemoBuyer(ownerId)) return;
  await db.$transaction(async (tx) => {
    const account = await lockAccount(tx, ownerId);
    const available = account.balanceCents - account.reservedCents;
    if (available >= DEMO_REFILL_BELOW_CENTS) return;
    const add = DEMO_CREDIT_CENTS - available;
    await tx.creditAccount.update({ where: { id: account.id }, data: { balanceCents: { increment: add } } });
    await tx.creditEntry.create({ data: { accountId: account.id, kind: 'demo_credit', amountCents: add } });
  });
}

export async function creditSummary(db: Db, ownerId: string) {
  const account = await db.$transaction((tx) => accountFor(tx, ownerId));
  const [entries, topUps] = await Promise.all([
    db.creditEntry.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.creditTopUp.findMany({ where: { accountId: account.id, status: { not: 'pending_payment' } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  return {
    balanceCents: account.balanceCents,
    reservedCents: account.reservedCents,
    availableCents: account.balanceCents - account.reservedCents,
    entries: entries.map((e) => ({ id: e.id, kind: e.kind, amountCents: e.amountCents, answerId: e.answerId, topUpId: e.topUpId, createdAt: e.createdAt })),
    topUps: topUps.map((t) => ({ id: t.id, amountCents: t.amountCents, status: t.status, captureId: t.captureId, createdAt: t.createdAt })),
  };
}

// ---------------------------------------------------------------- top-ups

export async function startTopUp(db: Db, paypal: PayPalGateway, args: { ownerId: string; amountCents: number; appBaseUrl: string }) {
  if (!Number.isInteger(args.amountCents) || args.amountCents < 100 || args.amountCents > MAX_TOP_UP_CENTS) {
    throw new CreditError('Top-ups are between $1 and $100.', 'invalid');
  }
  const account = await db.$transaction((tx) => accountFor(tx, args.ownerId));
  const id = `${TOP_UP_PREFIX}${randomBytes(12).toString('hex')}`;
  await db.creditTopUp.create({ data: { id, accountId: account.id, amountCents: args.amountCents } });
  let order: Order;
  try {
    order = await paypal.createOrder(
      {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: id, custom_id: id, description: 'TracePay answer credits', amount: { currency_code: 'USD', value: centsToDecimal(args.amountCents) } }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'TracePay',
              shipping_preference: 'NO_SHIPPING',
              user_action: 'PAY_NOW',
              return_url: `${args.appBaseUrl}/ask?topup=${id}`,
              cancel_url: `${args.appBaseUrl}/ask`,
            },
          },
        },
      },
      `order-${id}`,
    );
  } catch (err) {
    await db.creditTopUp.update({ where: { id }, data: { status: 'payment_failed' } });
    throw new PaymentError('PayPal couldn’t start this payment right now. Nothing was charged; please try again.', 'provider');
  }
  // Reconciliation follows it from here: a buyer can approve and close the tab before we capture.
  const firstCheck = after(ORDER_CHECK_DELAYS_MS[0]!);
  await db.creditTopUp.update({ where: { id }, data: { orderId: order.id, nextCheckAt: firstCheck } });
  notifyScheduled(firstCheck);
  await db.$transaction((tx) => appendAudit(tx, { entityType: 'credit_account', entityId: account.id, eventType: 'credits.top_up_started', payload: { topUpId: id, amountCents: args.amountCents } }));
  const approveUrl = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
  return { topUpId: id, orderId: order.id, approveUrl, amountCents: args.amountCents };
}

/** Captures a top-up the buyer approved in PayPal, then credits what PayPal verifiably took. */
export async function captureTopUp(db: Db, paypal: PayPalGateway, topUpId: string, ownerId: string) {
  const topUp = await db.creditTopUp.findUnique({ where: { id: topUpId }, include: { account: true } });
  if (!topUp || topUp.account.ownerId !== ownerId || !topUp.orderId) throw new CreditError('Top-up not found.', 'not_found');
  if (topUp.status !== 'pending_payment') return topUpOut(topUp);

  let order: Order;
  try {
    order = await paypal.captureOrder(topUp.orderId, `capture-${topUpId}`);
  } catch (err) {
    if (err instanceof PayPalApiError && err.issue === 'ORDER_ALREADY_CAPTURED') order = await paypal.getOrder(topUp.orderId);
    else if (err instanceof PayPalApiError && err.status === 422) {
      throw new PaymentError(err.issue === 'ORDER_NOT_APPROVED' ? 'The payment has not been approved in PayPal yet.' : 'PayPal could not complete this payment.', 'state');
    } else {
      // The capture may have gone through with only the reply lost: never claim it didn't.
      throw new PaymentError('We couldn’t confirm this payment with PayPal yet. If it went through, the credit appears automatically — TracePay keeps checking.', 'provider');
    }
  }
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new PaymentError('PayPal returned no capture for this payment.', 'verification');
  await applyTopUpCapture(db, topUpId, capture, 'api');
  return topUpOut(await db.creditTopUp.findUniqueOrThrow({ where: { id: topUpId } }));
}

/**
 * Applies a verified capture to a top-up (from our own capture call or a webhook).
 * Idempotent. Credits exactly what PayPal captured, in USD, for this top-up only.
 */
export async function applyTopUpCapture(db: Db, topUpId: string, capture: Capture, via: 'api' | 'webhook' | 'reconciliation'): Promise<string> {
  return db.$transaction(async (tx) => {
    // Lock order everywhere: audit chain → account → top-up / answer rows.
    await lockAuditChain(tx);
    const head = await tx.creditTopUp.findUnique({ where: { id: topUpId }, include: { account: true } });
    if (!head) return 'ignored: unknown top-up';
    await lockAccount(tx, head.account.ownerId);
    await tx.$queryRaw`SELECT id FROM "CreditTopUp" WHERE id = ${topUpId} FOR UPDATE`;
    const topUp = await tx.creditTopUp.findUniqueOrThrow({ where: { id: topUpId }, include: { account: true } });
    if (topUp.status !== 'pending_payment') return `noop: top-up ${topUp.status}`;
    if (capture.custom_id && capture.custom_id !== topUpId) return 'ignored: capture belongs to another payment';
    if (capture.amount.currency_code !== 'USD') {
      await tx.creditTopUp.update({ where: { id: topUpId }, data: { status: 'payment_failed', captureId: capture.id, nextCheckAt: null } });
      await appendAudit(tx, { entityType: 'credit_account', entityId: topUp.accountId, eventType: 'credits.top_up_failed', payload: { topUpId, reason: `currency ${capture.amount.currency_code}` } });
      return 'top-up rejected: not USD';
    }
    if (capture.status === 'PENDING') {
      // PayPal holds it (e.g. an eCheck): keep following it until it settles either way.
      await tx.creditTopUp.update({ where: { id: topUpId }, data: { captureId: capture.id, nextCheckAt: after(PENDING_CAPTURE_DELAYS_MS[0]!) } });
      return 'top-up pending at PayPal';
    }
    if (capture.status !== 'COMPLETED') {
      await tx.creditTopUp.update({ where: { id: topUpId }, data: { status: 'payment_failed', captureId: capture.id, nextCheckAt: null } });
      await appendAudit(tx, { entityType: 'credit_account', entityId: topUp.accountId, eventType: 'credits.top_up_failed', payload: { topUpId, captureId: capture.id, captureStatus: capture.status } });
      return `top-up ${capture.status}`;
    }
    const cents = decimalToCents(capture.amount.value);
    await tx.creditTopUp.update({ where: { id: topUpId }, data: { status: 'captured', captureId: capture.id, capturedAt: new Date(), creditedCents: cents, nextCheckAt: null } });
    await tx.creditAccount.update({ where: { id: topUp.accountId }, data: { balanceCents: { increment: cents } } });
    await tx.creditEntry.create({ data: { accountId: topUp.accountId, kind: 'top_up', amountCents: cents, topUpId } });
    await appendAudit(tx, { entityType: 'credit_account', entityId: topUp.accountId, eventType: 'credits.topped_up', payload: { topUpId, captureId: capture.id, amountCents: cents, via } });
    return `top-up ${topUpId} credited ${cents}¢`;
  });
}

/**
 * A refund (or reversal) of a top-up in PayPal: the money is gone, so is the credit.
 * Each refund is debited once — keyed by its PayPal id — and partial refunds add up;
 * the top-up counts as refunded once they reach what it credited. The balance may go
 * below zero (the credit was already spent); new answers then wait for a top-up.
 */
export async function reverseTopUp(db: Db, captureId: string, refund: { id: string | null; cents: number | null }, eventType: string): Promise<string | null> {
  const head = await db.creditTopUp.findUnique({ where: { captureId }, include: { account: true } });
  if (!head) return null;
  return db.$transaction(async (tx) => {
    await lockAuditChain(tx);
    await lockAccount(tx, head.account.ownerId);
    await tx.$queryRaw`SELECT id FROM "CreditTopUp" WHERE id = ${head.id} FOR UPDATE`;
    const t = await tx.creditTopUp.findUniqueOrThrow({ where: { id: head.id } });
    if (t.status !== 'captured') return `noop: top-up ${t.status}`;
    if (refund.id && (await tx.creditEntry.findUnique({ where: { refundId: refund.id } }))) return `noop: refund ${refund.id} already applied`;
    const left = t.creditedCents - t.refundedCents;
    // A reversal (no amount) takes back whatever is left.
    const cents = Math.min(refund.cents ?? left, left);
    if (cents <= 0) return `noop: top-up ${t.id} already fully refunded`;
    const refundedCents = t.refundedCents + cents;
    await tx.creditTopUp.update({ where: { id: t.id }, data: { refundedCents, status: refundedCents >= t.creditedCents ? 'refunded' : 'captured' } });
    await tx.creditAccount.update({ where: { id: t.accountId }, data: { balanceCents: { decrement: cents } } });
    await tx.creditEntry.create({ data: { accountId: t.accountId, kind: 'top_up_reversal', amountCents: -cents, topUpId: t.id, refundId: refund.id } });
    const clawedBack = await clawBack(tx, t.accountId);
    await appendAudit(tx, { entityType: 'credit_account', entityId: t.accountId, eventType: 'credits.top_up_reversed', payload: { topUpId: t.id, captureId, refundId: refund.id, amountCents: cents, eventType, clawedBackCents: clawedBack } });
    return `top-up ${t.id}: ${cents}¢ taken back (${eventType})${clawedBack ? `, ${clawedBack}¢ of unpaid royalties reversed` : ''}`;
  });
}

/**
 * The account's balance went below zero (its money was refunded after being spent): the
 * royalties that money funded and that haven't been paid out yet are reversed — newest
 * first — so authors are never paid from money that no longer exists. Royalties already
 * paid stay paid; that loss is the platform's (see the clearing period before payouts).
 */
async function clawBack(tx: Tx, accountId: string): Promise<number> {
  const account = await tx.creditAccount.findUniqueOrThrow({ where: { id: accountId } });
  let shortfall = -account.balanceCents;
  if (shortfall <= 0) return 0;
  const credits = await tx.citationCredit.findMany({
    where: { status: 'accrued', answer: { accountId } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, amountCents: true },
  });
  const reversed: string[] = [];
  let total = 0;
  for (const c of credits) {
    if (shortfall <= 0) break;
    reversed.push(c.id);
    shortfall -= c.amountCents;
    total += c.amountCents;
  }
  if (reversed.length) await tx.citationCredit.updateMany({ where: { id: { in: reversed }, status: 'accrued' }, data: { status: 'reversed' } });
  return total;
}

function topUpOut(t: { id: string; amountCents: number; status: string; captureId: string | null; createdAt: Date }) {
  return { topUpId: t.id, amountCents: t.amountCents, status: t.status, captureId: t.captureId, createdAt: t.createdAt };
}
