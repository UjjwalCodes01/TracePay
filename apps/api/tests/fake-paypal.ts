import { centsToDecimal } from '@tracepay/shared';
import { PayPalApiError } from '../src/integrations/paypal/client';
import type { PayPalGateway } from '../src/integrations/paypal/gateway';
import type { Capture, CreateOrderRequest, Order, PayoutBatchStatus, PayoutItemRequest, PayoutItemState } from '../src/integrations/paypal/types';

/**
 * In-memory PayPal sandbox stand-in that enforces the behaviours TracePay
 * relies on: orders must be approved before capture, captures happen once,
 * PayPal-Request-Id and sender_batch_id are idempotency keys.
 */
export class FakePayPal implements PayPalGateway {
  payoutsScope = true;
  /** Make the next createPayoutBatch fail after PayPal has accepted it (lost response). */
  loseNextPayoutResponse = false;
  calls = { createOrder: 0, captureOrder: 0, createPayoutBatch: 0 };

  private seq = 0;
  private orders = new Map<string, { req: CreateOrderRequest; status: Order['status']; capture?: Capture }>();
  private orderByRequestId = new Map<string, string>();
  private batches = new Map<string, { senderBatchId: string; items: PayoutItemRequest[]; status: Map<string, PayoutItemState> }>();
  private batchBySender = new Map<string, string>();

  async hasPayoutsScope() {
    return this.payoutsScope;
  }

  async createOrder(req: CreateOrderRequest, requestId: string): Promise<Order> {
    this.calls.createOrder++;
    const existing = this.orderByRequestId.get(requestId);
    if (existing) return this.view(existing);
    const id = `ORDER-${++this.seq}`;
    this.orders.set(id, { req, status: 'PAYER_ACTION_REQUIRED' });
    this.orderByRequestId.set(requestId, id);
    return this.view(id);
  }

  /** What the buyer does in the PayPal popup. */
  approve(orderId: string) {
    this.orders.get(orderId)!.status = 'APPROVED';
  }

  async getOrder(orderId: string): Promise<Order> {
    if (!this.orders.has(orderId)) throw new PayPalApiError(404, 'orders.get', { name: 'RESOURCE_NOT_FOUND' }, 'dbg');
    return this.view(orderId);
  }

  async captureOrder(orderId: string, _requestId: string, overrides: Partial<Capture> = {}): Promise<Order> {
    this.calls.captureOrder++;
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalApiError(404, 'orders.capture', { name: 'RESOURCE_NOT_FOUND' }, 'dbg');
    if (o.status === 'COMPLETED') {
      throw new PayPalApiError(422, 'orders.capture', { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 'dbg');
    }
    if (o.status !== 'APPROVED') {
      throw new PayPalApiError(422, 'orders.capture', { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 'dbg');
    }
    const pu = o.req.purchase_units[0]!;
    o.status = 'COMPLETED';
    o.capture = {
      id: `CAPTURE-${orderId}`,
      status: 'COMPLETED',
      amount: pu.amount,
      custom_id: pu.custom_id,
      seller_receivable_breakdown: { gross_amount: pu.amount, paypal_fee: { currency_code: 'USD', value: '0.89' } },
      ...overrides,
    };
    return this.view(orderId);
  }

  async createPayoutBatch(args: { senderBatchId: string; emailSubject: string; emailMessage: string; items: PayoutItemRequest[] }) {
    this.calls.createPayoutBatch++;
    if (this.batchBySender.has(args.senderBatchId)) {
      throw new PayPalApiError(400, 'payouts.create', { name: 'USER_BUSINESS_ERROR', message: 'Batch with given sender_batch_id already exists' }, 'dbg');
    }
    const id = `BATCH-${++this.seq}`;
    this.batches.set(id, {
      senderBatchId: args.senderBatchId,
      items: args.items,
      status: new Map(args.items.map((i) => [i.sender_item_id, 'PENDING' as PayoutItemState])),
    });
    this.batchBySender.set(args.senderBatchId, id);
    if (this.loseNextPayoutResponse) {
      this.loseNextPayoutResponse = false;
      throw new TypeError('fetch failed (response lost)');
    }
    return { batch_header: { payout_batch_id: id, batch_status: 'PENDING' as const, sender_batch_header: { sender_batch_id: args.senderBatchId } } };
  }

  setItemStatus(batchId: string, senderItemId: string, status: PayoutItemState) {
    this.batches.get(batchId)!.status.set(senderItemId, status);
  }

  setAllItems(batchId: string, status: PayoutItemState) {
    const b = this.batches.get(batchId)!;
    for (const k of b.status.keys()) b.status.set(k, status);
  }

  private denied = new Set<string>();
  denyBatch(batchId: string) {
    this.denied.add(batchId);
  }
  undenyBatch(batchId: string) {
    this.denied.delete(batchId);
  }

  batchIdFor(senderBatchId: string) {
    return this.batchBySender.get(senderBatchId);
  }

  async getPayoutBatch(payoutBatchId: string): Promise<PayoutBatchStatus> {
    const b = this.batches.get(payoutBatchId);
    if (!b) throw new PayPalApiError(404, 'payouts.get', { name: 'RESOURCE_NOT_FOUND' }, 'dbg');
    const states = [...b.status.values()];
    const batchStatus = this.denied.has(payoutBatchId)
      ? 'DENIED'
      : states.every((s) => s === 'SUCCESS')
        ? 'SUCCESS'
        : states.some((s) => s === 'PENDING')
          ? 'PROCESSING'
          : 'SUCCESS';
    return {
      batch_header: { payout_batch_id: payoutBatchId, batch_status: batchStatus, sender_batch_header: { sender_batch_id: b.senderBatchId } },
      items: b.items.map((i, n) => ({
        payout_item_id: `ITEM-${payoutBatchId}-${n}`,
        transaction_id: b.status.get(i.sender_item_id) === 'SUCCESS' ? `TX-${n}` : undefined,
        transaction_status: b.status.get(i.sender_item_id)!,
        payout_item: i,
      })),
    };
  }

  async verifyWebhookSignature(_webhookId: string, headers: { transmissionSig: string }, _rawBody: string) {
    return headers.transmissionSig === 'valid-signature';
  }

  private view(id: string): Order {
    const o = this.orders.get(id)!;
    const pu = o.req.purchase_units[0]!;
    return {
      id,
      status: o.status,
      links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
      payer: o.status === 'COMPLETED' ? { email_address: 'buyer@personal.example.com' } : undefined,
      purchase_units: [{ reference_id: pu.reference_id, custom_id: pu.custom_id, amount: pu.amount, payments: o.capture ? { captures: [o.capture] } : undefined }],
    };
  }
}

export const usd = (cents: number) => ({ currency_code: 'USD', value: centsToDecimal(cents) });
