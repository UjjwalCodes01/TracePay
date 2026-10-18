import { centsToDecimal, decimalToCents } from '@tracepay/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { PayPalApiError } from '../../integrations/paypal/client';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Capture, Order } from '../../integrations/paypal/types';
import { appendAudit } from '../audit/audit-log';
import { calculateForSale } from '../settlements/settlement.service';

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
    throw new PaymentError('This artifact is not listed for sale.', 'not_for_sale');
  }

  const sale = await db.$transaction(async (tx) => {
    const s = await tx.sale.create({
      data: { artifactId: artifact.id, buyerId: args.buyerId, amountCents: artifact.priceCents, currency: artifact.currency },
    });
    await appendAudit(tx, {
      entityType: 'sale',
      entityId: s.id,
      artifactId: artifact.id,
      eventType: 'sale.created',
      payload: { amountCents: s.amountCents, currency: s.currency, contentHash: artifact.contentHash },
    });
    return s;
  });

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

  if (payment.sale.status === 'captured') {
    const run = await db.settlementRun.findUnique({ where: { saleId }, select: { id: true } });
    return outcome(payment.sale.status, payment, run?.id ?? null, true);
  }

  let order: Order;
  try {
    order = await paypal.captureOrder(payment.orderId, `capture-${saleId}`);
  } catch (err) {
    if (err instanceof PayPalApiError && err.issue === 'ORDER_ALREADY_CAPTURED') {
      order = await paypal.getOrder(payment.orderId);
    } else if (err instanceof PayPalApiError && err.status === 422) {
      throw new PaymentError(`PayPal refused the capture: ${err.issue ?? err.message}`, 'state');
    } else {
      throw new PaymentError(`PayPal capture failed: ${(err as Error).message}`, 'provider');
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

    if (sale.status === 'captured') {
      const run = await tx.settlementRun.findUnique({ where: { saleId }, select: { id: true } });
      return outcome(sale.status, payment, run?.id ?? null, true);
    }

    const problems = verifyCapture(sale, capture);
    const capturedCents = decimalToCents(capture.amount.value);
    const feeCents = capture.seller_receivable_breakdown?.paypal_fee
      ? decimalToCents(capture.seller_receivable_breakdown.paypal_fee.value)
      : null;

    const status = problems.length ? 'exception' : capture.status === 'COMPLETED' ? 'captured' : 'pending_payment';

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
    if (status === 'captured') runId = (await calculateForSale(tx, saleId)).id;
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

/** Refund / reversal from PayPal: the sale becomes an exception for reconciliation. */
export async function markSaleReversed(tx: Tx, captureId: string, eventType: string): Promise<string | null> {
  const payment = await tx.payPalPayment.findUnique({ where: { captureId }, include: { sale: true } });
  if (!payment) return null;
  const refunded = eventType.endsWith('REFUNDED');
  await tx.sale.update({ where: { id: payment.saleId }, data: { status: refunded ? 'refunded' : 'exception' } });
  const run = await tx.settlementRun.findUnique({ where: { saleId: payment.saleId } });
  if (run && run.status !== 'exception') {
    await tx.settlementRun.update({ where: { id: run.id }, data: { status: 'exception' } });
  }
  await appendAudit(tx, {
    entityType: 'sale',
    entityId: payment.saleId,
    artifactId: payment.sale.artifactId,
    eventType: refunded ? 'sale.refunded' : 'sale.reversed',
    payload: {
      captureId,
      paypalEvent: eventType,
      settlementRunId: run?.id ?? null,
      settlementStatusBefore: run?.status ?? null,
      policy: 'Settlement flagged as exception. Contributor payouts already sent are reconciled under the license agreement.',
    },
  });
  return payment.saleId;
}
