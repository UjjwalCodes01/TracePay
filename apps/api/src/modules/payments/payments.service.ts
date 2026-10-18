import { centsToDecimal, decimalToCents } from '@tracepay/shared';
import { ZodError } from 'zod';
import type { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Capture, Order } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { todayUtc } from '../builds/preflight.service';
import { checkSaleRights, withdrawArtifact } from '../sales/rights.service';
import { SettlementError } from '../settlements/engine';
import { calculateForSale, recordFailedSettlement, SettlementStateError } from '../settlements/settlement.service';

export class PaymentError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'not_for_sale' | 'state' | 'verification' | 'provider') {
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
}

/**
 * Creates the internal sale first, then the PayPal order that references it
 * (reference_id and custom_id both carry the sale id). The order is created
 * server-side; the browser only ever sees the order id.
 */
export async function startCheckout(
  db: Db,
  paypal: PayPalGateway,
  args: { artifactId: string; buyerId: string | null; appBaseUrl: string },
): Promise<CheckoutStarted> {
  const artifact = await db.artifact.findUnique({ where: { id: args.artifactId } });
  if (!artifact) throw new PaymentError(`Artifact ${args.artifactId} not found.`, 'not_found');
  if (artifact.status !== 'listed' || artifact.priceCents <= 0) {
    throw new PaymentError('This report is not for sale right now.', 'not_for_sale');
  }
  if (args.buyerId && (await db.sale.count({ where: { artifactId: artifact.id, buyerId: args.buyerId, status: 'captured' } })) > 0) {
    throw new PaymentError('You already own this report.', 'state');
  }
  // Re-clicking "Pay" reuses the buyer's open checkout instead of piling up sales and
  // PayPal orders. (PayPal orders stay approvable for ~3 hours; reuse within 2.)
  if (args.buyerId) {
    const open = await db.sale.findFirst({
      where: { artifactId: artifact.id, buyerId: args.buyerId, status: 'pending_payment', createdAt: { gt: new Date(Date.now() - 2 * 60 * 60_000) }, payment: { isNot: null } },
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
    const s = await tx.sale.create({
      data: {
        artifactId: artifact.id,
        buyerId: args.buyerId,
        amountCents: artifact.priceCents,
        currency: artifact.currency,
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
        payment_source: {
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
    await db.sale.update({ where: { id: sale.id }, data: { status: 'payment_failed' } });
    throw new PaymentError(`PayPal order creation failed: ${(err as Error).message}`, 'provider');
  }

  await db.payPalPayment.create({ data: { saleId: sale.id, orderId: order.id, orderStatus: order.status } });
  const approveUrl = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
  return { saleId: sale.id, orderId: order.id, approveUrl, amountCents: sale.amountCents };
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

  // Last check before taking money: if a license was revoked or expired while the
  // buyer was in the PayPal window, don't capture at all — the buyer is never charged.
  if (payment.sale.termsSnapshot) {
    const rights = await db.$transaction((tx) => checkSaleRights(tx, payment.sale.artifactId));
    if (!rights.ok) {
      await db.$transaction(async (tx) => {
        if (rights.permanent) await withdrawArtifact(tx, payment.sale.artifactId, rights.reasons, 'system');
        await tx.sale.update({ where: { id: saleId }, data: { status: 'payment_failed' } });
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
  via: 'api' | 'webhook',
): Promise<CaptureOutcome> {
  return db.$transaction(async (tx) => {
    // Row lock: concurrent capture response + webhook serialise here.
    await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: { payment: true, artifact: true } });
    const payment = sale.payment!;

    // Only a sale still waiting for payment can move. A captured, refunded or
    // reversed sale never goes back — e.g. a COMPLETED webhook redelivered after
    // the refund must not resurrect it.
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
  input: { captureId: string; saleIdHint: string | null; eventType: string; refundedCents: number | null },
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
  const partial = isRefund && input.refundedCents !== null && payment.capturedCents !== null && input.refundedCents < payment.capturedCents;
  await tx.sale.update({ where: { id: payment.saleId }, data: { status: isRefund && !partial ? 'refunded' : 'exception' } });
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
  return payment.saleId;
}
