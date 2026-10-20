import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildIntent } from '@tracepay/shared';
import { db } from '../../src/db';
import { createApiKey, signUp } from '../../src/modules/auth/auth.service';
import { verifyAuditChain } from '../../src/modules/audit/audit-log';
import { preflightAndRecord } from '../../src/modules/builds/preflight.service';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { DEMO_ASSETS, DEMO_IDS } from '../../src/modules/demo/world';
import { generateArtifact } from '../../src/modules/generation/generation.service';
import { FixtureReportWriter } from '../../src/modules/generation/writers';
import { PayPalApiError } from '../../src/integrations/paypal/client';
import { captureSale, startCheckout } from '../../src/modules/payments/payments.service';
import { handlePayPalWebhook } from '../../src/modules/payments/webhooks.service';
import { checkPayment, nextReconcileAt, reconcileDue, ReconciliationWorker, UNCONFIRMED_AFTER_MS } from '../../src/modules/reconciliation/sync';
import { approveSettlement, refreshPayouts, retryFailedPayouts, submitPayouts } from '../../src/modules/settlements/settlement.service';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

const A = 'asset_northwind_index_v1';
const B = 'asset_okafor_notes_v1';
const D = 'asset_lumen_digest_v1';
const APP = 'http://localhost:5173';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const intent: BuildIntent = {
  title: 'Developer Tools Market Brief, Q4 2026',
  brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includesRawData: false,
  territory: 'US',
  priceCents: 2000,
  currency: 'USD',
};

/** Reconciliation as if `ms` had passed. */
const later = (ms: number) => () => new Date(Date.now() + ms);

async function listedArtifact(): Promise<string> {
  const { buildId } = await db().$transaction((tx) =>
    preflightAndRecord(tx, { publisherId: DEMO_IDS.publisher, intent, assetVersionIds: [A, B, D], asOf: '2026-10-18' }),
  );
  return (await generateArtifact(db(), buildId, new FixtureReportWriter())).artifactId!;
}

async function checkout(paypal: FakePayPal) {
  return startCheckout(db(), paypal, { artifactId: await listedArtifact(), buyerId: DEMO_IDS.buyer, appBaseUrl: APP });
}

async function paidSale(paypal: FakePayPal) {
  const c = await checkout(paypal);
  paypal.approve(c.orderId);
  const captured = await captureSale(db(), paypal, c.saleId);
  return { ...c, runId: captured.settlementRunId! };
}

async function paidOut(paypal: FakePayPal) {
  const sale = await paidSale(paypal);
  await approveSettlement(db(), sale.runId, DEMO_IDS.publisher);
  const batch = (await submitPayouts(db(), paypal, sale.runId))!;
  return { ...sale, batchId: batch.id, paypalBatchId: paypal.batchIdFor(batch.senderBatchId)! };
}

const payment = (saleId: string) => db().payPalPayment.findUniqueOrThrow({ where: { saleId } });
const sale = (saleId: string) => db().sale.findUniqueOrThrow({ where: { id: saleId } });
const issues = (subjectId: string) => db().reconciliationIssue.findMany({ where: { subjectId }, orderBy: { openedAt: 'asc' } });
const events = async (type: string) => (await db().outboundEvent.findMany({ where: { ownerId: DEMO_IDS.publisher, type } })).length;

describe.runIf(process.env.TEST_DATABASE_URL)('reconciliation with PayPal (integration)', () => {
  let paypal: FakePayPal;

  beforeEach(async () => {
    await resetAndSeed(db());
    paypal = new FakePayPal();
  });

  describe('checkouts the buyer never finished', () => {
    it('captures an order the buyer approved but never came back from (closed the tab)', async () => {
      const c = await checkout(paypal);
      expect((await payment(c.saleId)).nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 14 * MIN);
      paypal.approve(c.orderId);
      // Not due yet: nothing happens.
      expect((await reconcileDue(db(), paypal)).payments).toBe(0);
      const result = await reconcileDue(db(), paypal, { now: later(16 * MIN) });
      expect(result.outcomes[0]).toMatch(/captured on the buyer's behalf → captured/);
      expect((await sale(c.saleId)).status).toBe('captured');
      expect(await db().settlementRun.count({ where: { saleId: c.saleId } })).toBe(1);
      // From now on it is watched for refunds.
      expect((await payment(c.saleId)).nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    });

    it('re-checks the license first: if it was revoked meanwhile, the buyer is not charged', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      await db().licenseGrant.update({ where: { id: DEMO_ASSETS[0]!.licenseId }, data: { status: 'revoked' } });
      await reconcileDue(db(), paypal, { now: later(16 * MIN) });
      expect((await sale(c.saleId)).status).toBe('payment_failed');
      expect(paypal.calls.captureOrder).toBe(0);
      expect((await payment(c.saleId)).nextCheckAt).toBeNull();
    });

    it('never captures twice when the buyer and reconciliation act at the same moment', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      await Promise.all([captureSale(db(), paypal, c.saleId), reconcileDue(db(), paypal, { now: later(16 * MIN) })]);
      expect((await sale(c.saleId)).status).toBe('captured');
      expect(await db().settlementRun.count({ where: { saleId: c.saleId } })).toBe(1);
      expect((await verifyAuditChain(db())).ok).toBe(true);
    });

    it('keeps waiting while the buyer may still pay, then expires the checkout', async () => {
      const c = await checkout(paypal);
      expect((await reconcileDue(db(), paypal, { now: later(16 * MIN) })).outcomes[0]).toMatch(/waiting for the buyer/);
      expect((await sale(c.saleId)).status).toBe('pending_payment');
      await db().payPalPayment.update({ where: { saleId: c.saleId }, data: { nextCheckAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(3 * DAY + MIN) });
      expect((await sale(c.saleId)).status).toBe('payment_failed');
      expect((await payment(c.saleId)).nextCheckAt).toBeNull();
      expect(await events('sale.expired')).toBe(1);
    });

    it('closes a checkout PayPal has forgotten — only after a second “not found”, well after creation', async () => {
      const c = await checkout(paypal);
      paypal.expireOrder(c.orderId);
      // One "not found" (could be a PayPal hiccup) changes nothing.
      expect((await reconcileDue(db(), paypal, { now: later(16 * MIN) })).outcomes[0]).toMatch(/not found/);
      expect((await sale(c.saleId)).status).toBe('pending_payment');
      // Nor does a second one too early.
      await db().payPalPayment.update({ where: { saleId: c.saleId }, data: { nextCheckAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(HOUR) });
      expect((await sale(c.saleId)).status).toBe('pending_payment');
      await db().payPalPayment.update({ where: { saleId: c.saleId }, data: { nextCheckAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(4 * HOUR) });
      expect((await sale(c.saleId)).status).toBe('payment_failed');
    });

    it('never captures a stale approved order: past the 2-hour window it is closed, uncharged', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      expect((await reconcileDue(db(), paypal, { now: later(3 * HOUR) })).outcomes[0]).toMatch(/not captured/);
      expect((await sale(c.saleId)).status).toBe('payment_failed');
      expect(paypal.calls.captureOrder).toBe(0);
    });

    it('never charges twice when the buyer started over with a new checkout', async () => {
      const a = await checkout(paypal);
      paypal.approve(a.orderId);
      // Hours later the buyer returns and buys again: the old checkout is closed at once…
      const old = new Date(Date.now() - 3 * HOUR);
      await db().sale.update({ where: { id: a.saleId }, data: { createdAt: old } });
      const b = await startCheckout(db(), paypal, { artifactId: (await sale(a.saleId)).artifactId, buyerId: DEMO_IDS.buyer, appBaseUrl: APP });
      expect(b.saleId).not.toBe(a.saleId);
      expect((await sale(a.saleId)).status).toBe('payment_failed');
      // …so reconciliation can't capture it while the buyer pays for the new one.
      paypal.approve(b.orderId);
      await captureSale(db(), paypal, b.saleId);
      await db().payPalPayment.update({ where: { saleId: a.saleId }, data: { nextCheckAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(MIN) });
      expect(paypal.calls.captureOrder).toBe(1);
      expect((await db().sale.findMany({ where: { buyerId: DEMO_IDS.buyer, status: 'captured' } })).length).toBe(1);
    });

    it('never captures for a report taken off sale', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      await db().artifact.update({ where: { id: (await sale(c.saleId)).artifactId }, data: { status: 'withdrawn' } });
      await reconcileDue(db(), paypal, { now: later(16 * MIN) });
      expect((await sale(c.saleId)).status).toBe('payment_failed');
      expect(paypal.calls.captureOrder).toBe(0);
    });

    it('never drops money PayPal took for a checkout TracePay had closed', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      // TracePay closed it (it looked abandoned)…
      await db().sale.update({ where: { id: c.saleId }, data: { status: 'payment_failed' } });
      // …but the capture went through at PayPal and reaches us.
      const order = await paypal.captureOrder(c.orderId, 'x');
      const { applyCapture } = await import('../../src/modules/payments/payments.service');
      await applyCapture(db(), c.saleId, order, order.purchase_units![0]!.payments!.captures![0]!, 'webhook');
      expect((await sale(c.saleId)).status).toBe('exception');
      expect((await issues(c.saleId)).map((i) => i.kind)).toEqual(['capture_after_close']);
      expect((await payment(c.saleId)).nextCheckAt).not.toBeNull();
    });
  });

  describe('pending captures', () => {
    it('follows a pending capture until PayPal completes it', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      paypal.nextCaptureOverrides = { status: 'PENDING' };
      await captureSale(db(), paypal, c.saleId);
      expect((await sale(c.saleId)).status).toBe('pending_payment');
      expect((await reconcileDue(db(), paypal, { now: later(16 * MIN) })).outcomes[0]).toMatch(/still pending/);
      paypal.settlePendingCapture(c.orderId, 'COMPLETED');
      await db().payPalPayment.update({ where: { saleId: c.saleId }, data: { nextCheckAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(MIN) });
      expect((await sale(c.saleId)).status).toBe('captured');
      expect(await db().settlementRun.count({ where: { saleId: c.saleId } })).toBe(1);
    });

    it('records a declined pending capture as a failed payment that needs a look', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      paypal.nextCaptureOverrides = { status: 'PENDING' };
      await captureSale(db(), paypal, c.saleId);
      paypal.settlePendingCapture(c.orderId, 'DECLINED');
      await reconcileDue(db(), paypal, { now: later(16 * MIN) });
      expect((await sale(c.saleId)).status).toBe('payment_failed');
      expect((await issues(c.saleId)).map((i) => i.kind)).toEqual(['capture_declined']);
      expect(await events('sale.declined')).toBe(1);
    });
  });

  describe('refunds made directly in PayPal', () => {
    it('notices a refund no webhook announced, holds the settlement and asks for attention — once', async () => {
      const s = await paidSale(paypal);
      paypal.refundOutside(s.orderId);
      await reconcileDue(db(), paypal, { now: later(DAY + MIN) });
      expect((await sale(s.saleId)).status).toBe('refunded');
      expect((await db().settlementRun.findUniqueOrThrow({ where: { id: s.runId } })).status).toBe('exception');
      const [issue] = await issues(s.saleId);
      expect(issue).toMatchObject({ kind: 'sale_refunded', status: 'open' });
      expect(await events('reconciliation.issue_opened')).toBe(1);

      // PayPal's webhook arriving afterwards changes nothing and says nothing new.
      const before = await db().auditEvent.count({ where: { eventType: 'sale.refunded' } });
      await handlePayPalWebhook(db(), paypal, {
        webhookId: 'WH-ID',
        headers: { authAlgo: 'x', certUrl: 'x', transmissionId: 'r1', transmissionSig: 'valid-signature', transmissionTime: 'now' },
        rawBody: JSON.stringify({ id: 'WH-REFUND-1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REFUND-1', amount: { currency_code: 'USD', value: '20.00' }, custom_id: s.saleId, links: [{ rel: 'up', href: `https://api/v2/payments/captures/CAPTURE-${s.orderId}` }] } }),
      });
      expect(await db().auditEvent.count({ where: { eventType: 'sale.refunded' } })).toBe(before);
      expect(await issues(s.saleId)).toHaveLength(1);
      expect((await verifyAuditChain(db())).ok).toBe(true);
    });

    it('treats a partial refund as an exception, not a full refund', async () => {
      const s = await paidSale(paypal);
      paypal.refundOutside(s.orderId, true);
      await reconcileDue(db(), paypal, { now: later(DAY + MIN) });
      expect((await sale(s.saleId)).status).toBe('exception');
      expect((await issues(s.saleId)).map((i) => i.kind)).toEqual(['sale_partially_refunded']);
    });

    it('“Check now” never uses up the refund watch; it ends 180 days after the sale', async () => {
      const s = await paidSale(paypal);
      for (let i = 0; i < 8; i++) {
        await db().payPalPayment.update({ where: { saleId: s.saleId }, data: { nextCheckAt: new Date() } });
        await reconcileDue(db(), paypal, { now: later(MIN) });
      }
      expect((await payment(s.saleId)).nextCheckAt).not.toBeNull();
      await db().payPalPayment.update({ where: { saleId: s.saleId }, data: { nextCheckAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(181 * DAY) });
      expect((await payment(s.saleId)).nextCheckAt).toBeNull();
    });

    it('keeps watching after a partial refund, and notices the rest being refunded', async () => {
      const s = await paidSale(paypal);
      paypal.refundOutside(s.orderId, true);
      await reconcileDue(db(), paypal, { now: later(DAY + MIN) });
      expect((await sale(s.saleId)).status).toBe('exception');
      expect((await payment(s.saleId)).nextCheckAt).not.toBeNull();
      paypal.refundOutside(s.orderId);
      await db().payPalPayment.update({ where: { saleId: s.saleId }, data: { nextCheckAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(MIN) });
      expect((await sale(s.saleId)).status).toBe('refunded');
      expect((await issues(s.saleId)).map((i) => i.kind)).toEqual(['sale_partially_refunded', 'sale_refunded']);
    });

    it('treats PayPal’s DENIED webhook for a pending payment as a decline, not a chargeback', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      paypal.nextCaptureOverrides = { status: 'PENDING' };
      await captureSale(db(), paypal, c.saleId);
      const denied = (n: string) =>
        handlePayPalWebhook(db(), paypal, {
          webhookId: 'WH-ID',
          headers: { authAlgo: 'x', certUrl: 'x', transmissionId: n, transmissionSig: 'valid-signature', transmissionTime: 'now' },
          rawBody: JSON.stringify({ id: n, event_type: 'PAYMENT.CAPTURE.DENIED', resource: { id: `CAPTURE-${c.orderId}`, status: 'DECLINED', amount: { currency_code: 'USD', value: '20.00' }, custom_id: c.saleId } }),
        });
      await denied('WH-DENY-1');
      expect((await sale(c.saleId)).status).toBe('payment_failed');
      await denied('WH-DENY-2');
      expect((await sale(c.saleId)).status).toBe('payment_failed');
      expect((await issues(c.saleId)).map((i) => i.kind)).toEqual(['capture_declined']);
    });
  });

  describe('payouts', () => {
    it('follows a batch to the end without any webhook, then stops polling', async () => {
      const p = await paidOut(paypal);
      expect((await db().payoutBatch.findUniqueOrThrow({ where: { id: p.batchId } })).nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
      expect((await reconcileDue(db(), paypal, { now: later(2 * MIN) })).outcomes).toContain('refreshed');
      expect((await db().settlementRun.findUniqueOrThrow({ where: { id: p.runId } })).status).toBe('payout_submitted');
      paypal.setAllItems(p.paypalBatchId, 'SUCCESS');
      await db().payoutBatch.update({ where: { id: p.batchId }, data: { nextPollAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(MIN) });
      expect((await db().settlementRun.findUniqueOrThrow({ where: { id: p.runId } })).status).toBe('completed');
      expect((await db().payoutBatch.findUniqueOrThrow({ where: { id: p.batchId } })).nextPollAt).toBeNull();
    });

    it('flags unclaimed payouts and clears the flag by itself once they are claimed', async () => {
      const p = await paidOut(paypal);
      paypal.setAllItems(p.paypalBatchId, 'UNCLAIMED');
      await reconcileDue(db(), paypal, { now: later(2 * MIN) });
      expect((await issues(p.runId)).map((i) => [i.kind, i.status])).toEqual([['payout_unclaimed', 'open']]);
      expect((await db().payoutBatch.findUniqueOrThrow({ where: { id: p.batchId } })).nextPollAt).not.toBeNull(); // still watched
      paypal.setAllItems(p.paypalBatchId, 'SUCCESS');
      await db().payoutBatch.update({ where: { id: p.batchId }, data: { nextPollAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(MIN) });
      expect((await issues(p.runId)).map((i) => [i.kind, i.status, i.resolvedBy])).toEqual([['payout_unclaimed', 'resolved', 'auto']]);
      expect(await events('reconciliation.issue_resolved')).toBe(1);
    });

    it('flags failed payouts until a retry delivers them', async () => {
      const p = await paidOut(paypal);
      paypal.setAllItems(p.paypalBatchId, 'FAILED');
      await reconcileDue(db(), paypal, { now: later(2 * MIN) });
      expect((await issues(p.runId))[0]).toMatchObject({ kind: 'payout_failed', status: 'open' });
      const retry = (await retryFailedPayouts(db(), paypal, p.runId))!;
      paypal.setAllItems(paypal.batchIdFor(retry.senderBatchId)!, 'SUCCESS');
      await refreshPayouts(db(), paypal, p.runId);
      expect((await issues(p.runId))[0]).toMatchObject({ kind: 'payout_failed', status: 'resolved', resolvedBy: 'auto' });
      expect((await db().settlementRun.findUniqueOrThrow({ where: { id: p.runId } })).status).toBe('completed');
    });

    it('keeps refreshing older attempts: their pending payouts finish too', async () => {
      const p = await paidOut(paypal);
      const items = await db().payoutItem.findMany({ where: { batchId: p.batchId }, orderBy: { senderItemId: 'asc' } });
      paypal.setItemStatus(p.paypalBatchId, items[0]!.senderItemId, 'FAILED');
      paypal.setItemStatus(p.paypalBatchId, items[1]!.senderItemId, 'UNCLAIMED');
      await refreshPayouts(db(), paypal, p.runId);
      const retry = (await retryFailedPayouts(db(), paypal, p.runId))!;
      paypal.setAllItems(paypal.batchIdFor(retry.senderBatchId)!, 'SUCCESS');
      // The unclaimed payout in attempt 1 is claimed later.
      paypal.setItemStatus(p.paypalBatchId, items[1]!.senderItemId, 'SUCCESS');
      for (const it of items.slice(2)) paypal.setItemStatus(p.paypalBatchId, it.senderItemId, 'SUCCESS');
      await refreshPayouts(db(), paypal, p.runId);
      expect((await db().payoutItem.findUniqueOrThrow({ where: { id: items[1]!.id } })).status).toBe('SUCCESS');
      expect((await db().settlementRun.findUniqueOrThrow({ where: { id: p.runId } })).status).toBe('completed');
    });

    it('never writes a stale refresh over payouts a retry just moved (no double payout)', async () => {
      const p = await paidOut(paypal);
      paypal.setAllItems(p.paypalBatchId, 'FAILED');
      await refreshPayouts(db(), paypal, p.runId);
      // While PayPal answers about attempt 1, the publisher clicks "Retry failed payouts".
      const realGet = paypal.getPayoutBatch.bind(paypal);
      let retried = false;
      paypal.getPayoutBatch = async (id: string) => {
        const answer = await realGet(id);
        if (id === p.paypalBatchId && !retried) {
          retried = true;
          await retryFailedPayouts(db(), paypal, p.runId);
        }
        return answer;
      };
      const { refreshBatch } = await import('../../src/modules/settlements/settlement.service');
      await refreshBatch(db(), paypal, p.batchId);
      const items = await db().payoutItem.findMany({ where: { batch: { runId: p.runId } }, include: { batch: true } });
      expect(items.every((i) => i.batch.attempt === 2 && i.status === 'PENDING')).toBe(true);
      // So a second retry finds nothing to retry.
      await expect(retryFailedPayouts(db(), paypal, p.runId)).rejects.toThrow(/no failed payouts/);
    });

    it('schedules a check for every send, so an interrupted one is never forgotten', async () => {
      const s = await paidSale(paypal);
      await approveSettlement(db(), s.runId, DEMO_IDS.publisher);
      const original = paypal.createPayoutBatch.bind(paypal);
      let seen: { status: string; sendingSince: Date | null; nextPollAt: Date | null } | null = null;
      paypal.createPayoutBatch = async (args) => {
        seen = await db().payoutBatch.findFirstOrThrow({ where: { runId: s.runId }, select: { status: true, sendingSince: true, nextPollAt: true } });
        return original(args);
      };
      await submitPayouts(db(), paypal, s.runId);
      expect(seen!.status).toBe('SUBMITTING');
      expect(seen!.sendingSince).not.toBeNull();
      expect(seen!.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 2 * MIN);
    });

    it('tells a person when PayPal refused a send, and clears it once a resend is accepted', async () => {
      const s = await paidSale(paypal);
      await approveSettlement(db(), s.runId, DEMO_IDS.publisher);
      const original = paypal.createPayoutBatch.bind(paypal);
      paypal.createPayoutBatch = async () => {
        throw new PayPalApiError(422, 'payouts.create', { name: 'INSUFFICIENT_FUNDS' }, 'dbg');
      };
      await expect(submitPayouts(db(), paypal, s.runId)).rejects.toThrow();
      const batch = await db().payoutBatch.findFirstOrThrow({ where: { runId: s.runId } });
      expect((await issues(batch.id)).map((i) => [i.kind, i.status])).toEqual([['payout_submit_failed', 'open']]);
      paypal.createPayoutBatch = original;
      await submitPayouts(db(), paypal, s.runId);
      await refreshPayouts(db(), paypal, s.runId);
      expect((await issues(batch.id))[0]).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });
    });

    it('refuses to resend a batch PayPal may no longer recognise (older than 25 days)', async () => {
      const s = await paidSale(paypal);
      await approveSettlement(db(), s.runId, DEMO_IDS.publisher);
      paypal.createPayoutBatch = async () => {
        throw new TypeError('fetch failed');
      };
      await expect(submitPayouts(db(), paypal, s.runId)).rejects.toThrow();
      const batch = await db().payoutBatch.findFirstOrThrow({ where: { runId: s.runId } });
      await db().payoutBatch.update({
        where: { id: batch.id },
        data: { status: 'SUBMITTING', createdAt: new Date(Date.now() - 26 * DAY), sendingSince: new Date(Date.now() - DAY), nextPollAt: new Date() },
      });
      let sent = 0;
      paypal.createPayoutBatch = async () => {
        sent++;
        throw new Error('must not be called');
      };
      expect((await reconcileDue(db(), paypal, { now: later(MIN) })).outcomes[0]).toMatch(/too old/);
      expect(sent).toBe(0);
      expect((await issues(batch.id)).find((i) => i.kind === 'payout_stuck')).toMatchObject({ status: 'open' });
    });

    it('doesn’t reopen what a person marked as handled while nothing changed', async () => {
      const p = await paidOut(paypal);
      paypal.setAllItems(p.paypalBatchId, 'UNCLAIMED');
      await reconcileDue(db(), paypal, { now: later(2 * MIN) });
      const [issue] = await issues(p.runId);
      const { resolveIssueById } = await import('../../src/modules/reconciliation/issues');
      await db().$transaction((tx) => resolveIssueById(tx, { ownerId: DEMO_IDS.publisher, issueId: issue!.id, userId: DEMO_IDS.publisher, resolution: 'Told them.' }));
      await refreshPayouts(db(), paypal, p.runId);
      await refreshPayouts(db(), paypal, p.runId);
      expect(await issues(p.runId)).toHaveLength(1);
    });

    it('finishes a send that was interrupted mid-request, with the same batch id (never paying twice)', async () => {
      const s = await paidSale(paypal);
      await approveSettlement(db(), s.runId, DEMO_IDS.publisher);
      const original = paypal.createPayoutBatch.bind(paypal);
      paypal.createPayoutBatch = async () => {
        throw new TypeError('fetch failed');
      };
      await expect(submitPayouts(db(), paypal, s.runId)).rejects.toThrow();
      paypal.createPayoutBatch = original;
      // As if the process had died while sending: SUBMITTING, long ago, due for a check.
      const batch = await db().payoutBatch.findFirstOrThrow({ where: { runId: s.runId } });
      await db().payoutBatch.update({ where: { id: batch.id }, data: { status: 'SUBMITTING', updatedAt: new Date(Date.now() - 10 * MIN), nextPollAt: new Date() } });
      const result = await reconcileDue(db(), paypal, { now: later(MIN) });
      expect(result.outcomes[0]).toMatch(/resubmitted/);
      const sent = await db().payoutBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(sent.paypalBatchId).toBeTruthy();
      expect(paypal.calls.createPayoutBatch).toBe(1);
    });

    it('tells a person when PayPal never confirms a batch, and clears it when the webhook brings the id', async () => {
      const s = await paidSale(paypal);
      await approveSettlement(db(), s.runId, DEMO_IDS.publisher);
      paypal.loseNextPayoutResponse = true;
      await submitPayouts(db(), paypal, s.runId).catch(() => undefined);
      const batch = await db().payoutBatch.findFirstOrThrow({ where: { runId: s.runId } });
      // The lost response: our next send is answered "duplicate" → awaiting confirmation.
      await submitPayouts(db(), paypal, s.runId).catch(() => undefined);
      await db().payoutBatch.update({ where: { id: batch.id }, data: { status: 'AWAITING_CONFIRMATION', paypalBatchId: null, nextPollAt: new Date() } });
      await reconcileDue(db(), paypal, { now: later(UNCONFIRMED_AFTER_MS + MIN) });
      const byKind = async (kind: string) => (await issues(batch.id)).find((i) => i.kind === kind);
      expect(await byKind('payout_unconfirmed')).toMatchObject({ status: 'open' });
      // The "not sent" from the lost response was cleared as soon as PayPal said it had the batch.
      expect(await byKind('payout_submit_failed')).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });

      const paypalBatchId = paypal.batchIdFor(batch.senderBatchId)!;
      paypal.setAllItems(paypalBatchId, 'SUCCESS');
      await handlePayPalWebhook(db(), paypal, {
        webhookId: 'WH-ID',
        headers: { authAlgo: 'x', certUrl: 'x', transmissionId: 'p1', transmissionSig: 'valid-signature', transmissionTime: 'now' },
        rawBody: JSON.stringify({ id: 'WH-PAYOUT-1', event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: paypalBatchId, sender_batch_header: { sender_batch_id: batch.senderBatchId } } } }),
      });
      expect(await byKind('payout_unconfirmed')).toMatchObject({ status: 'resolved', resolvedBy: 'auto' });
      expect((await db().settlementRun.findUniqueOrThrow({ where: { id: s.runId } })).status).toBe('completed');
    });
  });

  describe('robustness', () => {
    it('backs off when PayPal is down — no tight loop, lease released', async () => {
      const c = await checkout(paypal);
      paypal.getOrder = async () => {
        throw new PayPalApiError(503, 'orders.get', { name: 'SERVICE_UNAVAILABLE' }, 'dbg');
      };
      const before = await payment(c.saleId);
      const outcome = await checkPayment(db(), paypal, before.id, new Date(Date.now() + 16 * MIN));
      expect(outcome).toMatch(/error/);
      const after = await payment(c.saleId);
      expect(after.checkLockedUntil).toBeNull();
      expect(after.checkCount).toBe(1);
      expect(after.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 16 * MIN);
    });

    it('lets concurrent workers share the work without doing anything twice', async () => {
      const sales = await Promise.all([1, 2, 3].map(async () => {
        const c = await checkout(paypal);
        paypal.approve(c.orderId);
        return c;
      }));
      const results = await Promise.all(Array.from({ length: 8 }, () => reconcileDue(db(), paypal, { now: later(16 * MIN) })));
      expect(results.reduce((n, r) => n + r.payments, 0)).toBe(3);
      expect(paypal.calls.captureOrder).toBe(3);
      for (const c of sales) expect(await db().settlementRun.count({ where: { saleId: c.saleId } })).toBe(1);
    });

    it('the worker sleeps until the next check and stops cleanly', async () => {
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      const next = await nextReconcileAt(db());
      expect(next!.getTime()).toBeGreaterThan(Date.now() + 14 * MIN);
      await db().payPalPayment.update({ where: { saleId: c.saleId }, data: { nextCheckAt: new Date() } });
      const worker = new ReconciliationWorker(() => ({ db: db(), paypal }));
      worker.kick();
      for (let i = 0; i < 60 && (await sale(c.saleId)).status !== 'captured'; i++) await new Promise((r) => setTimeout(r, 100));
      await worker.stop();
      expect((await sale(c.saleId)).status).toBe('captured');
    });

    it('stops after repeated hard errors and tells a person', async () => {
      const c = await checkout(paypal);
      paypal.getOrder = async () => {
        throw new PayPalApiError(403, 'orders.get', { name: 'NOT_AUTHORIZED' }, 'dbg');
      };
      const id = (await payment(c.saleId)).id;
      for (let i = 0; i < 10; i++) await checkPayment(db(), paypal, id, new Date(Date.now() + 16 * MIN));
      expect((await payment(c.saleId)).nextCheckAt).toBeNull();
      expect((await issues(c.saleId)).map((i) => i.kind)).toEqual(['check_stuck']);
    });

    it('wakes up for something newly scheduled, without waiting for traffic', async () => {
      const worker = new ReconciliationWorker(() => ({ db: db(), paypal }));
      const c = await checkout(paypal);
      paypal.approve(c.orderId);
      await db().payPalPayment.update({ where: { saleId: c.saleId }, data: { nextCheckAt: new Date() } });
      worker.scheduledFor(new Date());
      for (let i = 0; i < 60 && (await sale(c.saleId)).status !== 'captured'; i++) await new Promise((r) => setTimeout(r, 100));
      await worker.stop();
      expect((await sale(c.saleId)).status).toBe('captured');
    });

    it('does nothing at all without PayPal configured', async () => {
      const worker = new ReconciliationWorker(() => null);
      worker.kick();
      await new Promise((r) => setTimeout(r, 2_200));
      await worker.stop();
    });
  });

  describe('API', () => {
    it('“Reset demo” clears the demo publisher’s issues', async () => {
      const s = await paidSale(paypal);
      paypal.refundOutside(s.orderId);
      await reconcileDue(db(), paypal, { now: later(DAY + MIN) });
      expect(await db().reconciliationIssue.count({ where: { ownerId: DEMO_IDS.publisher } })).toBe(1);
      const { softResetDemo } = await import('../../src/modules/demo/soft-reset');
      await softResetDemo(db());
      expect(await db().reconciliationIssue.count({ where: { ownerId: DEMO_IDS.publisher } })).toBe(0);
    });

    it('summarises, lists, checks and resolves — for the owner only', async () => {
      const app = testApp(paypal);
      const atlas = { Authorization: `Bearer ${(await createApiKey(db(), DEMO_IDS.publisher, 'recon')).key}` };
      const s = await paidSale(paypal);
      paypal.refundOutside(s.orderId);
      await db().payPalPayment.update({ where: { saleId: s.saleId }, data: { nextCheckAt: new Date() } });

      const checked = await request(app).post('/api/v1/reconciliation/check').set(atlas).expect(200);
      expect(checked.body).toMatchObject({ object: 'reconciliation_check', checked_payments: 1, summary: { open_issues: 1, open_issues_by_kind: { sale_refunded: 1 } } });

      const list = await request(app).get('/api/v1/reconciliation/issues?status=open').set(atlas).expect(200);
      expect(list.body.data).toHaveLength(1);
      const issue = list.body.data[0];
      expect(issue).toMatchObject({ object: 'reconciliation_issue', kind: 'sale_refunded', subject: { type: 'sale', id: s.saleId }, status: 'open' });

      const saleRes = await request(app).get(`/api/v1/sales/${s.saleId}`).set(atlas).expect(200);
      expect(saleRes.body.reconciliation.last_checked_at).not.toBeNull();

      const other = await signUp(db(), { email: 'other@recon.example', password: 'a long enough password', name: 'Other', role: 'publisher' });
      const theirs = { Authorization: `Bearer ${(await createApiKey(db(), other.id, 'x')).key}` };
      await request(app).get(`/api/v1/reconciliation/issues/${issue.id}`).set(theirs).expect(404);
      await request(app).post(`/api/v1/reconciliation/issues/${issue.id}/resolve`).set(theirs).send({ resolution: 'Not mine' }).expect(404);
      expect((await request(app).get('/api/v1/reconciliation').set(theirs).expect(200)).body.open_issues).toBe(0);

      await request(app).post(`/api/v1/reconciliation/issues/${issue.id}/resolve`).set(atlas).send({ resolution: 'x' }).expect(400);
      const resolved = await request(app).post(`/api/v1/reconciliation/issues/${issue.id}/resolve`).set(atlas).send({ resolution: 'Settled with the contributors by bank transfer.' }).expect(200);
      expect(resolved.body).toMatchObject({ status: 'resolved', resolved_by: 'user', resolution: 'Settled with the contributors by bank transfer.' });
      expect((await request(app).get('/api/v1/reconciliation').set(atlas).expect(200)).body.open_issues).toBe(0);
      // Resolving again is harmless.
      await request(app).post(`/api/v1/reconciliation/issues/${issue.id}/resolve`).set(atlas).send({ resolution: 'Again.' }).expect(200);
    });
  });
});
