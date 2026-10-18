import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Capture, WebhookEvent, WebhookVerificationHeaders } from '../../integrations/paypal/types';
import { applyCapture, markSaleReversed } from './payments.service';
import { refreshPayouts } from '../settlements/settlement.service';

export type WebhookResult =
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'processed'; eventId: string; outcome: string };

export function readVerificationHeaders(get: (name: string) => string | undefined): WebhookVerificationHeaders | null {
  const h = {
    authAlgo: get('paypal-auth-algo'),
    certUrl: get('paypal-cert-url'),
    transmissionId: get('paypal-transmission-id'),
    transmissionSig: get('paypal-transmission-sig'),
    transmissionTime: get('paypal-transmission-time'),
  };
  return Object.values(h).every(Boolean) ? (h as WebhookVerificationHeaders) : null;
}

/**
 * PayPal webhook handling:
 *  1. verify the signature with PayPal (unverified events are stored, never applied);
 *  2. dedupe on PayPal's event id — redeliveries are acknowledged and ignored;
 *  3. apply the event through the same idempotent paths the API uses.
 */
export async function handlePayPalWebhook(
  db: Db,
  paypal: PayPalGateway,
  args: { webhookId: string | undefined; headers: WebhookVerificationHeaders | null; rawBody: string },
): Promise<WebhookResult> {
  let event: WebhookEvent;
  try {
    event = JSON.parse(args.rawBody) as WebhookEvent;
  } catch {
    return { status: 'rejected', reason: 'invalid JSON' };
  }
  if (!event.id || !event.event_type) return { status: 'rejected', reason: 'not a PayPal event' };

  const verified =
    Boolean(args.webhookId && args.headers) &&
    (await paypal.verifyWebhookSignature(args.webhookId!, args.headers!, args.rawBody).catch(() => false));

  const resourceId = (event.resource as { id?: string } | null)?.id ?? null;
  try {
    await db.webhookEvent.create({
      data: { id: event.id, eventType: event.event_type, resourceId, verified, payload: event as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return { status: 'duplicate', eventId: event.id };
    throw err;
  }

  if (!verified) {
    await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), outcome: 'rejected: signature not verified' } });
    return { status: 'rejected', reason: 'signature not verified' };
  }

  const outcome = await applyEvent(db, paypal, event);
  await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), outcome } });
  return { status: 'processed', eventId: event.id, outcome };
}

async function applyEvent(db: Db, paypal: PayPalGateway, event: WebhookEvent): Promise<string> {
  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.PENDING': {
      const capture = event.resource as Capture;
      const saleId = await saleIdForCapture(db, capture);
      if (!saleId) return 'ignored: capture not linked to a TracePay sale';
      const result = await applyCapture(db, saleId, null, capture, 'webhook');
      return result.alreadyCaptured ? `noop: sale ${saleId} already captured` : `sale ${saleId} → ${result.saleStatus}`;
    }
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
    case 'PAYMENT.CAPTURE.DENIED': {
      const capture = event.resource as Capture & { links?: Array<{ rel: string; href: string }> };
      // A refund resource's id is the refund id; the capture id is in its "up" link.
      const captureId = event.event_type === 'PAYMENT.CAPTURE.REFUNDED'
        ? capture.links?.find((l) => l.rel === 'up')?.href.split('/').pop() ?? capture.id
        : capture.id;
      const saleId = await db.$transaction((tx) => markSaleReversed(tx, captureId, event.event_type));
      return saleId ? `sale ${saleId} flagged (${event.event_type})` : 'ignored: unknown capture';
    }
    default: {
      if (event.event_type.startsWith('PAYMENT.PAYOUTSBATCH.') || event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
        const r = event.resource as { batch_header?: { payout_batch_id?: string }; payout_batch_id?: string };
        const paypalBatchId = r.batch_header?.payout_batch_id ?? r.payout_batch_id;
        const batch = paypalBatchId ? await db.payoutBatch.findUnique({ where: { paypalBatchId } }) : null;
        if (!batch) return 'ignored: unknown payout batch';
        // Never trust the webhook payload for status — re-read it from PayPal.
        const res = await refreshPayouts(db, paypal, batch.runId);
        return `payout batch ${paypalBatchId} refreshed → ${res.runStatus}`;
      }
      return `ignored: ${event.event_type}`;
    }
  }
}

async function saleIdForCapture(db: Db, capture: Capture): Promise<string | null> {
  const byCapture = await db.payPalPayment.findUnique({ where: { captureId: capture.id }, select: { saleId: true } });
  if (byCapture) return byCapture.saleId;
  if (capture.custom_id) {
    const sale = await db.sale.findUnique({ where: { id: capture.custom_id }, select: { id: true } });
    if (sale) return sale.id;
  }
  return null;
}
