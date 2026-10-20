import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import type { PayPalGateway } from '../../integrations/paypal/gateway';
import type { Capture, WebhookEvent, WebhookVerificationHeaders } from '../../integrations/paypal/types';
import { decimalToCents } from '@tracepay/shared';
import { applyCapture, markSaleReversed, declineCapture } from './payments.service';
import { refreshBatch } from '../settlements/settlement.service';

export type WebhookResult =
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate'; eventId: string }
  | { status: 'processed'; eventId: string; outcome: string }
  | { status: 'failed'; eventId: string; error: string };

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

  // Verify BEFORE touching storage: unverified events are never recorded, so a
  // forged event can't pre-claim a real event id and make it look like a duplicate.
  const verified =
    Boolean(args.webhookId && args.headers) &&
    (await paypal.verifyWebhookSignature(args.webhookId!, args.headers!, args.rawBody).catch(() => false));
  if (!verified) return { status: 'rejected', reason: 'signature not verified' };

  const resourceId = (event.resource as { id?: string } | null)?.id ?? null;
  try {
    await db.webhookEvent.create({
      data: { id: event.id, eventType: event.event_type, resourceId, verified: true, payload: event as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    // Seen before. Only skip it if it was fully processed; a delivery that failed
    // mid-way is retried by PayPal and must be applied now.
    const prior = await db.webhookEvent.findUnique({ where: { id: event.id }, select: { processedAt: true } });
    if (prior?.processedAt) return { status: 'duplicate', eventId: event.id };
  }

  try {
    const outcome = await applyEvent(db, paypal, event);
    await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), outcome } });
    return { status: 'processed', eventId: event.id, outcome };
  } catch (err) {
    await db.webhookEvent.update({ where: { id: event.id }, data: { outcome: `failed: ${(err as Error).message.slice(0, 300)}` } }).catch(() => undefined);
    // Non-2xx makes PayPal redeliver later.
    return { status: 'failed', eventId: event.id, error: (err as Error).message };
  }
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
    case 'PAYMENT.CAPTURE.DENIED': {
      // A denied capture of a payment still pending (or already closed) is a decline: the
      // buyer was never charged — not a reversal of money we held.
      const capture = event.resource as Capture;
      const paid = await db.payPalPayment.findUnique({ where: { captureId: capture.id }, include: { sale: true } });
      const saleId = paid?.saleId ?? (await saleIdForCapture(db, capture));
      if (!saleId) return 'ignored: capture not linked to a TracePay sale';
      const sale = await db.sale.findUniqueOrThrow({ where: { id: saleId }, select: { status: true } });
      if (sale.status === 'pending_payment') {
        await declineCapture(db, saleId, capture);
        return `sale ${saleId} declined`;
      }
      if (sale.status === 'payment_failed') return `noop: sale ${saleId} already closed`;
      const flagged = await db.$transaction((tx) => markSaleReversed(tx, { captureId: capture.id, saleIdHint: capture.custom_id ?? null, eventType: event.event_type, refundedCents: null }));
      return flagged ? `sale ${flagged} flagged (${event.event_type})` : 'ignored: not a TracePay sale';
    }
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const resource = event.resource as Capture & { links?: Array<{ rel: string; href: string }> };
      const isRefund = event.event_type === 'PAYMENT.CAPTURE.REFUNDED';
      // A refund resource's id is the refund id; the capture id is in its "up" link.
      const captureId = isRefund ? resource.links?.find((l) => l.rel === 'up')?.href.split('/').pop() ?? resource.id : resource.id;
      const saleId = await db.$transaction((tx) =>
        markSaleReversed(tx, {
          captureId,
          saleIdHint: resource.custom_id ?? null,
          eventType: event.event_type,
          refundedCents: isRefund && resource.amount ? decimalToCents(resource.amount.value) : null,
        }),
      );
      return saleId ? `sale ${saleId} flagged (${event.event_type})` : 'ignored: not a TracePay sale';
    }
    default: {
      if (event.event_type.startsWith('PAYMENT.PAYOUTSBATCH.') || event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
        const r = event.resource as {
          batch_header?: { payout_batch_id?: string; sender_batch_header?: { sender_batch_id?: string } };
          payout_batch_id?: string;
          payout_item?: { sender_item_id?: string };
        };
        const paypalBatchId = r.batch_header?.payout_batch_id ?? r.payout_batch_id ?? null;
        const senderBatchId = r.batch_header?.sender_batch_header?.sender_batch_id ?? null;
        let batch = paypalBatchId ? await db.payoutBatch.findUnique({ where: { paypalBatchId } }) : null;
        // A batch whose create response was lost has no PayPal id yet: match it on OUR id and backfill.
        if (!batch && senderBatchId) batch = await db.payoutBatch.findUnique({ where: { senderBatchId } });
        if (!batch && r.payout_item?.sender_item_id) {
          batch = (await db.payoutItem.findUnique({ where: { senderItemId: r.payout_item.sender_item_id }, include: { batch: true } }))?.batch ?? null;
        }
        if (!batch) return 'ignored: unknown payout batch';
        if (!batch.paypalBatchId && paypalBatchId) {
          await db.payoutBatch.update({ where: { id: batch.id }, data: { paypalBatchId, status: 'PENDING' } });
          await db.payoutItem.updateMany({ where: { batchId: batch.id, status: 'SUBMITTING' }, data: { status: 'PENDING' } });
        }
        // Never trust the webhook payload for status — re-read THIS batch (any attempt) from PayPal.
        const res = await refreshBatch(db, paypal, batch.id);
        return `payout batch ${paypalBatchId ?? senderBatchId} refreshed → ${res.runStatus}`;
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
