import { centsToDecimal, decimalToCents } from '@tracepay/shared';
import { ZodError } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Capture, Order } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { openIssue, saleOwner } from '../reconciliation/issues';
import { after, nextRefundCheck, notifyScheduled, ORDER_CHECK_DELAYS_MS, PENDING_CAPTURE_DELAYS_MS } from '../reconciliation/schedule';
import { todayUtc } from '../builds/preflight.service';
import { checkSaleRights, withdrawArtifact } from '../sales/rights.service';
import { SettlementError } from '../settlements/engine';
import { calculateForSale, recordFailedSettlement, SettlementStateError } from '../settlements/settlement.service';
import { logger } from '../../http/logger';

export class PaymentError extends Error {
  /** unconfirmed: PayPal may have taken the money, but its reply was lost (a saved-wallet charge). */
  constructor(message: string, readonly code: 'not_found' | 'not_for_sale' | 'state' | 'verification' | 'provider' | 'unconfirmed') {
    super(message);
    this.name = 'PaymentError';
  }
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

export interface CheckoutStarted {
  saleId: string;
  orderId: string;
  approveUrl: string | null;
  amountCents: number;
  /** A saved wallet was charged at once: PayPal's completed order (verify it with applyCapture). */
  order?: Order;
}

/**
 * Creates the internal sale first, then the PayPal order that references it
 * (reference_id and custom_id both carry the sale id). The order is created
 * server-side; the browser only ever sees the order id.
 */
export async function startCheckout(
  db: Db,
  paypal: PayPalGateway,
  args: {
    artifactId: string;
    buyerId: string | null;
    appBaseUrl: string;
    /** The shared demo buyer may buy a report again. */
    allowRepeat?: boolean;
    /** Charge this saved PayPal wallet now (the buyer's assistant, within its mandate). */
    vault?: { vaultId: string; mandateId: string };
  },
): Promise<CheckoutStarted> {
  const artifact = await db.artifact.findUnique({ where: { id: args.artifactId } });
  if (!artifact) throw new PaymentError(`Artifact ${args.artifactId} not found.`, 'not_found');
  if (artifact.status !== 'listed' || artifact.priceCents <= 0) {
    throw new PaymentError('This report is not for sale right now.', 'not_for_sale');
  }
  const alreadyOwned = !!args.buyerId && (await db.sale.count({ where: { artifactId: artifact.id, buyerId: args.buyerId, status: 'captured' } })) > 0;
  if (alreadyOwned && !args.allowRepeat) throw new PaymentError('You already own this report.', 'state');
  // A payment PayPal is still processing (a pending capture) must finish first: closing
  // it to start again would leave real money untracked, and could charge the buyer twice.
  if (args.buyerId && (await db.sale.count({ where: { artifactId: artifact.id, buyerId: args.buyerId, status: 'pending_payment', payment: { captureId: { not: null } } } })) > 0) {
    throw new PaymentError('PayPal is still processing your earlier payment for this report. It unlocks as soon as PayPal confirms it.', 'state');
  }
  // Re-clicking "Pay" reuses the buyer's open checkout instead of piling up sales and
  // PayPal orders. (PayPal orders stay approvable for ~3 hours; reuse within 2.)
  if (args.buyerId && !args.vault) {
    const open = await db.sale.findFirst({
      // A checkout opened before the buyer owned it can't serve a repeat purchase (it would be refused at capture).
      where: { artifactId: artifact.id, buyerId: args.buyerId, status: 'pending_payment', createdAt: { gt: new Date(Date.now() - 2 * 60 * 60_000) }, payment: { is: { captureId: null } }, ...(alreadyOwned ? { repeatPurchase: true } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { payment: true },
    });
    if (open?.payment) return { saleId: open.id, orderId: open.payment.orderId, approveUrl: null, amountCents: open.amountCents };
  }

  const result = await db.$transaction(async (tx) => {
    // Re-check every source's license as of today; a revoked or expired license stops the sale.
    const rights = await checkSaleRights(tx, artifact.id);
    if (!rights.ok) {
      // Only take it off sale for lasting problems (revoked / expired / no longer permitted).
      if (rights.permanent) await withdrawArtifact(tx, artifact.id, rights.reasons, 'system');
      return { rights, sale: null };
    }
    // Older open checkouts of this buyer for this report are over: the buyer started again.
    // (Reconciliation must never capture one of them as well — that would charge twice.)
    // Locked first, so a capture landing at the same moment is seen; and only checkouts
    // PayPal has taken no money for are closed.
    if (args.buyerId) {
      const open = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Sale" WHERE "artifactId" = ${artifact.id} AND "buyerId" = ${args.buyerId} AND status = 'pending_payment' FOR UPDATE`;
      if (open.length) {
        const pendingCapture = await tx.payPalPayment.count({ where: { saleId: { in: open.map((o) => o.id) }, captureId: { not: null } } });
        if (pendingCapture) throw new PaymentError('PayPal is still processing your earlier payment for this report. It unlocks as soon as PayPal confirms it.', 'state');
      }
      for (const old of open) {
        const closed = await tx.sale.updateMany({ where: { id: old.id, status: 'pending_payment' }, data: { status: 'payment_failed' } });
        if (!closed.count) continue;
        await tx.payPalPayment.updateMany({ where: { saleId: old.id }, data: { nextCheckAt: null } });
        await appendAudit(tx, { entityType: 'sale', entityId: old.id, artifactId: artifact.id, eventType: 'sale.checkout_expired', payload: { reason: 'The buyer started a new checkout.' } });
      }
    }
    const s = await tx.sale.create({
      data: {
        artifactId: artifact.id,
        buyerId: args.buyerId,
        amountCents: artifact.priceCents,
        currency: artifact.currency,
        repeatPurchase: alreadyOwned,
        mandateId: args.vault?.mandateId ?? null,
        rightsCheck: json({ asOf: todayUtc(), verdict: rights.report.verdict, policyVersion: rights.report.policyVersion }),
        termsSnapshot: json(rights.snapshot),
        snapshotHash: rights.snapshotHash,
      },
    });
    await appendAudit(tx, {
      entityType: 'sale',
      entityId: s.id,
      artifactId: artifact.id,
      eventType: 'sale.created',
      payload: { amountCents: s.amountCents, currency: s.currency, contentHash: artifact.contentHash, termsSnapshotHash: rights.snapshotHash },
    });
    return { rights, sale: s };
  });
  if (!result.sale) {
    const r = result.rights.ok ? null : result.rights;
    throw new PaymentError(
      r?.permanent
        ? `This report can no longer be sold: ${r.reasons[0]} It has been taken off sale.`
        : 'This report is temporarily unavailable while a contributor updates their payout details. Please try again later.',
      'not_for_sale',
    );
  }
  const sale = result.sale;

  let order: Order;
  try {
    order = await paypal.createOrder(
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: sale.id,
            custom_id: sale.id,
            description: artifact.title.slice(0, 127),
            amount: { currency_code: sale.currency, value: centsToDecimal(sale.amountCents) },
          },
        ],
        payment_source: args.vault
          ? { paypal: { vault_id: args.vault.vaultId } }
          : {
              paypal: {
                experience_context: {
                  brand_name: 'TracePay',
                  shipping_preference: 'NO_SHIPPING',
                  user_action: 'PAY_NOW',
                  return_url: `${args.appBaseUrl}/checkout/return?sale=${sale.id}`,
                  cancel_url: `${args.appBaseUrl}/checkout/cancel?sale=${sale.id}`,
                },
              },
            },
      },
      `order-${sale.id}`,
    );
  } catch (err) {
    // Charging a saved wallet IS creating the order: a lost reply may mean PayPal took the money.
    // Never call that "failed" — flag it for a person (the request id makes any retry the same order).
    const definite = err instanceof PayPalApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
    if (args.vault && !definite) {
      await db.$transaction(async (tx) => {
        await tx.sale.update({ where: { id: sale.id }, data: { status: 'exception' } });
        await appendAudit(tx, { entityType: 'sale', entityId: sale.id, artifactId: artifact.id, eventType: 'sale.capture_exception', payload: { problems: ['saved-PayPal charge sent, PayPal reply lost'], requestId: `order-${sale.id}` } });
        const owner = await saleOwner(tx, sale.id);
        if (owner) await openIssue(tx, { ownerId: owner.ownerId, kind: 'saved_payment_unconfirmed', subjectType: 'sale', subjectId: sale.id, artifactId: owner.artifactId, data: { requestId: `order-${sale.id}` } });
      });
      logger.error({ err, saleId: sale.id }, 'saved-PayPal charge unconfirmed');
      throw new PaymentError('PayPal didn’t confirm the payment. It has been flagged for checking, and it can’t be charged twice.', 'unconfirmed');
    }
    await db.sale.update({ where: { id: sale.id }, data: { status: 'payment_failed' } });
    logger.warn({ err, saleId: sale.id }, 'PayPal order creation failed');
    if (args.vault && err instanceof PayPalApiError && err.status === 403) {
      throw new PaymentError('Paying with saved PayPal isn’t enabled for this PayPal app yet (PayPal’s Vault feature). Nothing was charged.', 'provider');
    }
    if (args.vault && err instanceof PayPalApiError && err.status === 422) {
      throw new PaymentError('PayPal declined the saved payment method. Nothing was charged.', 'state');
    }
    throw new PaymentError('PayPal couldn’t start this checkout right now. Nothing was charged; please try again.', 'provider');
  }

  // Reconciliation checks on it if the buyer never comes back (approved and closed the tab, or abandoned it).
  const firstCheck = after(ORDER_CHECK_DELAYS_MS[0]!);
  await db.payPalPayment.create({ data: { saleId: sale.id, orderId: order.id, orderStatus: order.status, nextCheckAt: firstCheck } });
  notifyScheduled(firstCheck);
  const approveUrl = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
  return { saleId: sale.id, orderId: order.id, approveUrl, amountCents: sale.amountCents, ...(args.vault ? { order } : {}) };
}

export interface CaptureOutcome {
  saleId: string;
  saleStatus: string;
  orderId: string;
  captureId: string | null;
  captureStatus: string | null;
  capturedCents: number | null;
  settlementRunId: string | null;
  alreadyCaptured: boolean;
}

/**
 * Captures a buyer-approved order and independently verifies the result.
 * Returning from the PayPal popup proves nothing; only PayPal's capture
 * response, matched against our sale, moves the sale to `captured`.
 */
export async function captureSale(db: Db, paypal: PayPalGateway, saleId: string): Promise<CaptureOutcome> {
  const payment = await db.payPalPayment.findUnique({ where: { saleId }, include: { sale: true } });
  if (!payment) throw new PaymentError(`No PayPal order for sale ${saleId}.`, 'not_found');

  if (payment.sale.status !== 'pending_payment') {
    const run = await db.settlementRun.findUnique({ where: { saleId }, select: { id: true } });
    return outcome(payment.sale.status, payment, run?.id ?? null, true);
  }

  // Before taking money: the report must still be on sale, and the buyer must not
  // already own it (e.g. bought through another checkout) — unless this checkout was
  // started as a deliberate repeat purchase. Otherwise: no charge.
  const artifact = await db.artifact.findUniqueOrThrow({ where: { id: payment.sale.artifactId }, select: { status: true } });
  const ownedElsewhere = payment.sale.buyerId && !payment.sale.repeatPurchase
    ? await db.sale.count({ where: { artifactId: payment.sale.artifactId, buyerId: payment.sale.buyerId, status: 'captured', id: { not: saleId } } })
    : 0;
  if (artifact.status !== 'listed' || ownedElsewhere) {
    const reason = ownedElsewhere ? 'The buyer already owns this report.' : 'The report was taken off sale.';
    await db.$transaction(async (tx) => {
      const moved = await tx.sale.updateMany({ where: { id: saleId, status: 'pending_payment' }, data: { status: 'payment_failed' } });
      if (moved.count) await tx.payPalPayment.update({ where: { saleId }, data: { nextCheckAt: null } });
      if (moved.count) await appendAudit(tx, { entityType: 'sale', entityId: saleId, artifactId: payment.sale.artifactId, eventType: 'sale.blocked_before_capture', payload: { reasons: [reason] } });
    });
    throw new PaymentError(ownedElsewhere ? 'You already own this report, so this payment was not taken.' : 'This report is no longer for sale, so your payment was not taken.', 'not_for_sale');
  }

  // Last check before taking money: if a license was revoked or expired while the
  // buyer was in the PayPal window, don't capture at all — the buyer is never charged.
  if (payment.sale.termsSnapshot) {
    const rights = await db.$transaction((tx) => checkSaleRights(tx, payment.sale.artifactId));
    if (!rights.ok && !rights.permanent) {
      // Temporary (a contributor is updating payout details): don't take the money now,
      // but leave the checkout open — the approved order can be captured once it's fixed.
      throw new PaymentError('This report is temporarily unavailable while a contributor updates their payout details. Your payment was not taken; please try again later.', 'not_for_sale');
    }
    if (!rights.ok) {
      await db.$transaction(async (tx) => {
        await withdrawArtifact(tx, payment.sale.artifactId, rights.reasons, 'system');
        const moved = await tx.sale.updateMany({ where: { id: saleId, status: 'pending_payment' }, data: { status: 'payment_failed' } });
        if (!moved.count) return; // captured meanwhile (another tab, a webhook): leave it to that path
        await tx.payPalPayment.update({ where: { saleId }, data: { nextCheckAt: null } });
        await appendAudit(tx, { entityType: 'sale', entityId: saleId, artifactId: payment.sale.artifactId, eventType: 'sale.blocked_before_capture', payload: { reasons: rights.reasons } });
      });
      throw new PaymentError('This report can no longer be sold, so your payment was not taken.', 'not_for_sale');
    }
  }

  let order: Order;
  try {
    order = await paypal.captureOrder(payment.orderId, `capture-${saleId}`);
  } catch (err) {
    if (err instanceof PayPalApiError && err.issue === 'ORDER_ALREADY_CAPTURED') {
      order = await paypal.getOrder(payment.orderId);
    } else if (err instanceof PayPalApiError && err.status === 422) {
      // Buyer-facing message only; PayPal's internals go to the log.
      throw new PaymentError(err.issue === 'ORDER_NOT_APPROVED' ? 'The payment has not been approved in PayPal yet.' : 'PayPal could not complete this payment.', 'state');
    } else {
      throw new PaymentError('PayPal is not responding right now. Your payment was not taken; please try again.', 'provider');
    }
  }

  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new PaymentError(`Order ${order.id} has no capture (status ${order.status}).`, 'verification');

  return applyCapture(db, saleId, order, capture, 'api');
}

/**
 * Applies a capture (from our own capture call or a verified webhook) to the
 * sale. Idempotent: a second application for an already-captured sale is a
 * no-op, so a duplicated webhook can never create a second settlement.
 */
export async function applyCapture(
  db: Db,
  saleId: string,
  order: Pick<Order, 'id' | 'status' | 'payer'> | null,
  capture: Capture,
  via: 'api' | 'webhook' | 'reconciliation',
): Promise<CaptureOutcome> {
  return db.$transaction(async (tx) => {
    // Row lock: concurrent capture response + webhook serialise here.
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { payment: true, artifact: true } });
    const payment = sale.payment!;

    // Only a sale still waiting for payment can move. A captured, refunded or
    // reversed sale never goes back — e.g. a COMPLETED webhook redelivered after
    // the refund must not resurrect it.
    // PayPal took money for a sale TracePay had already closed (a checkout that looked
    // expired, then completed after all). Never drop it: record it, flag it, watch it.
    // (Also a capture TracePay knew as pending on a sale that was closed: once PayPal
    // completes it, the money is taken all the same.)
    const lateMoney =
      (capture.status === 'COMPLETED' && (payment.captureId === null || payment.captureId === capture.id)) ||
      (capture.status === 'PENDING' && payment.captureId === null);
    if (sale.status === 'payment_failed' && lateMoney) {
      const p = await tx.payPalPayment.update({
        where: { saleId },
        data: {
          captureId: capture.id,
          captureStatus: capture.status,
          capturedCents: decimalToCents(capture.amount.value),
          rawCapture: json(capture),
          nextCheckAt: nextRefundCheck(new Date()),
          checkCount: 0,
        },
      });
      await tx.sale.update({ where: { id: saleId }, data: { status: 'exception' } });
      await appendAudit(tx, {
        entityType: 'sale',
        entityId: saleId,
        artifactId: sale.artifactId,
        eventType: 'sale.capture_exception',
        payload: { via, captureId: capture.id, captureStatus: capture.status, problems: ['captured after the checkout was closed'] },
      });
      const owner = await saleOwner(tx, saleId);
      if (owner) await openIssue(tx, { ownerId: owner.ownerId, kind: 'capture_after_close', subjectType: 'sale', subjectId: saleId, artifactId: owner.artifactId, data: { captureId: capture.id } });
      return outcome('exception', p, null, false);
    }
    if (sale.status !== 'pending_payment') {
      const run = await tx.settlementRun.findUnique({ where: { saleId }, select: { id: true } });
      return outcome(sale.status, payment, run?.id ?? null, true);
    }

    const problems = verifyCapture(sale, capture);
    const capturedCents = decimalToCents(capture.amount.value);
    const feeCents = capture.seller_receivable_breakdown?.paypal_fee
      ? decimalToCents(capture.seller_receivable_breakdown.paypal_fee.value)
      : null;

    // A capture PayPal already reports as refunded/reversed is not money we hold.
    const refundedAlready = ['REFUNDED', 'PARTIALLY_REFUNDED', 'REVERSED'].includes(capture.status);
    const status = problems.length || refundedAlready ? 'exception' : capture.status === 'COMPLETED' ? 'captured' : 'pending_payment';
    if (refundedAlready) problems.push(`capture already ${capture.status}`);

    const updatedPayment = await tx.payPalPayment.update({
      where: { saleId },
      data: {
        orderStatus: order?.status ?? payment.orderStatus,
        captureId: capture.id,
        captureStatus: capture.status,
        capturedCents,
        paypalFeeCents: feeCents,
        payerEmail: order?.payer?.email_address ?? payment.payerEmail,
        rawCapture: json(capture),
        // Reconciliation from here: watch a completed sale for refunds made in PayPal,
        // follow a pending capture until it settles, leave an exception to a person.
        nextCheckAt:
          status === 'captured' ? nextRefundCheck(new Date()) : status === 'pending_payment' ? after(PENDING_CAPTURE_DELAYS_MS[0]!) : null,
        checkCount: 0,
      },
    });
    await tx.sale.update({ where: { id: saleId }, data: { status } });

    await appendAudit(tx, {
      entityType: 'sale',
      entityId: saleId,
      artifactId: sale.artifactId,
      eventType: status === 'captured' ? 'sale.captured' : status === 'exception' ? 'sale.capture_exception' : 'sale.capture_pending',
      payload: {
        via,
        orderId: payment.orderId,
        captureId: capture.id,
        captureStatus: capture.status,
        capturedCents,
        paypalFeeCents: feeCents,
        problems,
      },
    });

    let runId: string | null = null;
    if (status === 'exception') {
      const owner = await saleOwner(tx, saleId);
      if (owner) {
        await openIssue(tx, {
          ownerId: owner.ownerId,
          kind: refundedAlready ? (capture.status === 'PARTIALLY_REFUNDED' ? 'sale_partially_refunded' : 'sale_refunded') : 'capture_mismatch',
          subjectType: 'sale',
          subjectId: saleId,
          artifactId: owner.artifactId,
          data: { problems, captureId: capture.id },
        });
      }
    }
    if (status === 'captured') {
      // The money is already captured at PayPal: recording it must never depend on the
      // settlement succeeding. A calculation problem becomes a settlement exception instead.
      try {
        runId = (await calculateForSale(tx, saleId)).id;
      } catch (err) {
        if (!(err instanceof SettlementError || err instanceof SettlementStateError || err instanceof ZodError)) throw err;
        runId = (await recordFailedSettlement(tx, saleId, (err as Error).message)).id;
      }
    }
    return outcome(status, updatedPayment, runId, false);
  });
}

function verifyCapture(sale: { id: string; amountCents: number; currency: string }, capture: Capture): string[] {
  const problems: string[] = [];
  if (capture.amount.currency_code !== sale.currency) problems.push(`currency ${capture.amount.currency_code} ≠ ${sale.currency}`);
  if (decimalToCents(capture.amount.value) !== sale.amountCents) problems.push(`amount ${capture.amount.value} ≠ ${centsToDecimal(sale.amountCents)}`);
  if (capture.custom_id !== undefined && capture.custom_id !== sale.id) problems.push(`custom_id ${capture.custom_id} ≠ ${sale.id}`);
  if (['DECLINED', 'FAILED'].includes(capture.status)) problems.push(`capture ${capture.status}`);
  return problems;
}

function outcome(
  saleStatus: string,
  p: { saleId: string; orderId: string; captureId: string | null; captureStatus: string | null; capturedCents: number | null },
  settlementRunId: string | null,
  alreadyCaptured: boolean,
): CaptureOutcome {
  return {
    saleId: p.saleId,
    saleStatus,
    orderId: p.orderId,
    captureId: p.captureId,
    captureStatus: p.captureStatus,
    capturedCents: p.capturedCents,
    settlementRunId,
    alreadyCaptured,
  };
}

export class RetryLaterError extends Error {}

/**
 * Refund / reversal from PayPal. A full refund marks the sale refunded; a
 * partial refund or a reversal makes it an exception. Either way the
 * settlement becomes an exception and no further payout can be sent.
 */
export async function markSaleReversed(
  tx: Tx,
  input: { captureId: string; saleIdHint: string | null; eventType: string; refundedCents: number | null; partial?: boolean },
): Promise<string | null> {
  let payment = await tx.payPalPayment.findUnique({ where: { captureId: input.captureId }, include: { sale: true } });
  if (!payment && input.saleIdHint) payment = await tx.payPalPayment.findUnique({ where: { saleId: input.saleIdHint }, include: { sale: true } });
  if (!payment) {
    // The refund can arrive before we recorded the capture. Ask PayPal to redeliver
    // rather than dropping it — otherwise we could later pay out on refunded money.
    if (input.saleIdHint === null) throw new RetryLaterError(`Capture ${input.captureId} is not recorded yet.`);
    return null; // carries a custom_id that isn't one of our sales
  }
  if (!payment.captureId) throw new RetryLaterError(`Sale ${payment.saleId} has no recorded capture yet.`);

  await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${payment.saleId} FOR UPDATE`;
  const run = await tx.settlementRun.findUnique({ where: { saleId: payment.saleId } });
  if (run) await tx.$queryRaw`SELECT id FROM "SettlementRun" WHERE id = ${run.id} FOR UPDATE`;

  const isRefund = input.eventType.endsWith('REFUNDED');
  const partial =
    isRefund && (input.partial ?? (input.refundedCents !== null && payment.capturedCents !== null && input.refundedCents < payment.capturedCents));
  const target = isRefund && !partial ? 'refunded' : 'exception';
  const kind = isRefund ? (partial ? 'sale_partially_refunded' : 'sale_refunded') : 'sale_reversed';
  // Already recorded (a webhook and reconciliation can both notice the same refund): nothing new to say.
  if (payment.sale.status === target && (await tx.reconciliationIssue.count({ where: { subjectId: payment.saleId, kind } }))) return payment.saleId;
  await tx.sale.update({ where: { id: payment.saleId }, data: { status: target } });
  // A full refund or reversal ends the watch (a person decides now). After a partial
  // refund keep watching: the rest may be refunded too.
  await tx.payPalPayment.update({
    where: { saleId: payment.saleId },
    data: { nextCheckAt: target === 'exception' && isRefund ? nextRefundCheck(payment.createdAt, new Date()) : null },
  });
  if (run && run.status !== 'exception') {
    await tx.settlementRun.update({ where: { id: run.id }, data: { status: 'exception' } });
  }
  await appendAudit(tx, {
    entityType: 'sale',
    entityId: payment.saleId,
    artifactId: payment.sale.artifactId,
    eventType: isRefund ? (partial ? 'sale.partially_refunded' : 'sale.refunded') : 'sale.reversed',
    payload: {
      captureId: input.captureId,
      refundedCents: input.refundedCents,
      paypalEvent: input.eventType,
      settlementRunId: run?.id ?? null,
      settlementStatusBefore: run?.status ?? null,
      policy: 'Settlement flagged as exception. Contributor payouts already sent are reconciled under the license agreement.',
    },
  });
  const owner = await saleOwner(tx, payment.saleId);
  if (owner) {
    await openIssue(tx, {
      ownerId: owner.ownerId,
      kind,
      subjectType: 'sale',
      subjectId: payment.saleId,
      artifactId: owner.artifactId,
      data: { captureId: input.captureId, refundedCents: input.refundedCents, settlementId: run?.id ?? null, via: input.eventType },
    });
  }
  return payment.saleId;
}

/**
 * A capture PayPal held as pending and then declined (reported by reconciliation or
 * by PayPal's DENIED webhook): no money moved, so the sale simply didn't happen.
 * Returns false when the sale wasn't waiting for that capture.
 */
export async function declineCapture(db: Db, saleId: string, capture: { id: string; status: string }): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
    const moved = await tx.sale.updateMany({ where: { id: saleId, status: 'pending_payment' }, data: { status: 'payment_failed' } });
    if (!moved.count) return false;
    await tx.payPalPayment.update({ where: { saleId }, data: { nextCheckAt: null, captureStatus: capture.status } });
    const owner = await saleOwner(tx, saleId);
    await appendAudit(tx, { entityType: 'sale', entityId: saleId, artifactId: owner?.artifactId ?? null, eventType: 'sale.capture_declined', payload: { captureId: capture.id, status: capture.status } });
    if (owner) await openIssue(tx, { ownerId: owner.ownerId, kind: 'capture_declined', subjectType: 'sale', subjectId: saleId, artifactId: owner.artifactId, data: { captureId: capture.id } });
    return true;
  });
}
