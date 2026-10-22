import { randomBytes } from 'node:crypto';
import { centsToDecimal, decimalToCents } from '@tracepay/shared';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Capture, Order } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { PaymentError } from '../payments/payments.service';

/**
 * Prepaid answer credits, bought with PayPal. Money enters only through a
 * server-verified PayPal capture; the balance is a ledger (entries sum to it).
 */

export const TOP_UP_AMOUNTS_CENTS = [500, 1000, 2000] as const;
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
    throw new PaymentError(`PayPal order creation failed: ${(err as Error).message}`, 'provider');
  }
  await db.creditTopUp.update({ where: { id }, data: { orderId: order.id } });
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
    } else throw new PaymentError('PayPal is not responding right now. Your payment was not taken; please try again.', 'provider');
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
export async function applyTopUpCapture(db: Db, topUpId: string, capture: Capture, via: 'api' | 'webhook'): Promise<string> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CreditTopUp" WHERE id = ${topUpId} FOR UPDATE`;
    const topUp = await tx.creditTopUp.findUnique({ where: { id: topUpId }, include: { account: true } });
    if (!topUp) return 'ignored: unknown top-up';
    if (topUp.status !== 'pending_payment') return `noop: top-up ${topUp.status}`;
    if (capture.custom_id && capture.custom_id !== topUpId) return 'ignored: capture belongs to another payment';
    if (capture.amount.currency_code !== 'USD') return 'ignored: not USD';
    if (capture.status === 'PENDING') return 'top-up pending at PayPal';
    if (capture.status !== 'COMPLETED') {
      await tx.creditTopUp.update({ where: { id: topUpId }, data: { status: 'payment_failed', captureId: capture.id } });
      return `top-up ${capture.status}`;
    }
    const cents = decimalToCents(capture.amount.value);
    await lockAccount(tx, topUp.account.ownerId);
    await tx.creditTopUp.update({ where: { id: topUpId }, data: { status: 'captured', captureId: capture.id, capturedAt: new Date() } });
    await tx.creditAccount.update({ where: { id: topUp.accountId }, data: { balanceCents: { increment: cents } } });
    await tx.creditEntry.create({ data: { accountId: topUp.accountId, kind: 'top_up', amountCents: cents, topUpId } });
    await appendAudit(tx, { entityType: 'credit_account', entityId: topUp.accountId, eventType: 'credits.topped_up', payload: { topUpId, captureId: capture.id, amountCents: cents, via } });
    return `top-up ${topUpId} credited ${cents}¢`;
  });
}

/**
 * A top-up refunded or reversed in PayPal: the money is gone, so is the credit. The
 * balance may go below zero (it was already spent); new answers then wait for a top-up.
 */
export async function reverseTopUp(db: Db, captureId: string, refundedCents: number | null, eventType: string): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const topUp = await tx.creditTopUp.findUnique({ where: { captureId }, include: { account: true } });
    if (!topUp) return null;
    await tx.$queryRaw`SELECT id FROM "CreditTopUp" WHERE id = ${topUp.id} FOR UPDATE`;
    const current = await tx.creditTopUp.findUniqueOrThrow({ where: { id: topUp.id } });
    if (current.status !== 'captured') return `noop: top-up ${current.status}`;
    const cents = Math.min(refundedCents ?? topUp.amountCents, topUp.amountCents);
    await lockAccount(tx, topUp.account.ownerId);
    await tx.creditTopUp.update({ where: { id: topUp.id }, data: { status: 'refunded' } });
    await tx.creditAccount.update({ where: { id: topUp.accountId }, data: { balanceCents: { decrement: cents } } });
    await tx.creditEntry.create({ data: { accountId: topUp.accountId, kind: 'top_up_reversal', amountCents: -cents, topUpId: topUp.id } });
    await appendAudit(tx, { entityType: 'credit_account', entityId: topUp.accountId, eventType: 'credits.top_up_reversed', payload: { topUpId: topUp.id, captureId, amountCents: cents, eventType } });
    return `top-up ${topUp.id} reversed (${eventType})`;
  });
}

function topUpOut(t: { id: string; amountCents: number; status: string; captureId: string | null; createdAt: Date }) {
  return { topUpId: t.id, amountCents: t.amountCents, status: t.status, captureId: t.captureId, createdAt: t.createdAt };
}
