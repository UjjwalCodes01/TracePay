import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildIntent, LicenseTerms } from '@tracepay/shared';
import { db } from '../../src/db';
import { verifyAuditChain } from '../../src/modules/audit/audit-log';
import { canonicalJson, sha256Hex } from '../../src/modules/audit/hash-chain';
import { preflightAndRecord } from '../../src/modules/builds/preflight.service';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { DEMO_ASSETS, DEMO_IDS } from '../../src/modules/demo/world';
import { generateArtifact } from '../../src/modules/generation/generation.service';
import { FixtureReportWriter } from '../../src/modules/generation/writers';
import { captureSale, PaymentError, startCheckout } from '../../src/modules/payments/payments.service';
import { handlePayPalWebhook } from '../../src/modules/payments/webhooks.service';
import { approveSettlement, refreshPayouts, SettlementStateError, submitPayouts } from '../../src/modules/settlements/settlement.service';
import { FakePayPal, usd } from '../fake-paypal';

const A = 'asset_northwind_index_v1';
const B = 'asset_okafor_notes_v1';
const D = 'asset_lumen_digest_v1';
const APP = 'http://localhost:5173';

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

async function listedArtifact(): Promise<string> {
  const { buildId } = await db().$transaction((tx) =>
    preflightAndRecord(tx, { publisherId: DEMO_IDS.publisher, intent, assetVersionIds: [A, B, D], asOf: '2026-10-18' }),
  );
  const { artifactId } = await generateArtifact(db(), buildId, new FixtureReportWriter());
  return artifactId!;
}

async function paidSale(paypal: FakePayPal) {
  const artifactId = await listedArtifact();
  const checkout = await startCheckout(db(), paypal, { artifactId, buyerId: DEMO_IDS.buyer, appBaseUrl: APP });
  paypal.approve(checkout.orderId);
  const captured = await captureSale(db(), paypal, checkout.saleId);
  return { artifactId, checkout, captured };
}

const webhook = (id: string, eventType: string, resource: unknown, sig = 'valid-signature') => ({
  webhookId: 'WH-ID',
  headers: { authAlgo: 'SHA256withRSA', certUrl: 'https://cert', transmissionId: id, transmissionSig: sig, transmissionTime: 'now' },
  rawBody: JSON.stringify({ id, event_type: eventType, resource, create_time: '2026-10-18T00:00:00Z' }),
});

describe.runIf(process.env.TEST_DATABASE_URL)('money path (integration)', () => {
  let paypal: FakePayPal;

  beforeEach(async () => {
    await resetAndSeed(db());
    paypal = new FakePayPal();
  });

  it('will not capture before the buyer approves', async () => {
    const artifactId = await listedArtifact();
    const { saleId } = await startCheckout(db(), paypal, { artifactId, buyerId: DEMO_IDS.buyer, appBaseUrl: APP });
    await expect(captureSale(db(), paypal, saleId)).rejects.toMatchObject({ code: 'state' });
    expect((await db().sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('pending_payment');
    expect(await db().settlementRun.count()).toBe(0);
  });

  it('captures, verifies and settles a $20 sale exactly', async () => {
    const { captured } = await paidSale(paypal);
    expect(captured).toMatchObject({ saleStatus: 'captured', captureStatus: 'COMPLETED', capturedCents: 2000, alreadyCaptured: false });

    const run = await db().settlementRun.findUniqueOrThrow({ where: { id: captured.settlementRunId! }, include: { lines: true } });
    const byRecipient = Object.fromEntries(run.lines.map((l) => [l.recipientId, l.amountCents]));
    expect(byRecipient).toEqual({ user_northwind: 500, user_okafor: 300, user_lumen: 200, [DEMO_IDS.publisher]: 1000 });
    expect(run.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(2000);
    expect(run.status).toBe('calculated');
  });

  it('is idempotent across repeated captures and duplicate webhooks', async () => {
    const { checkout, captured } = await paidSale(paypal);
    const again = await captureSale(db(), paypal, checkout.saleId);
    expect(again.alreadyCaptured).toBe(true);
    expect(paypal.calls.captureOrder).toBe(1);

    const resource = { id: captured.captureId, status: 'COMPLETED', amount: usd(2000), custom_id: checkout.saleId };
    const first = await handlePayPalWebhook(db(), paypal, webhook('WH-1', 'PAYMENT.CAPTURE.COMPLETED', resource));
    const dup = await handlePayPalWebhook(db(), paypal, webhook('WH-1', 'PAYMENT.CAPTURE.COMPLETED', resource));
    expect(first).toMatchObject({ status: 'processed', outcome: expect.stringContaining('noop') });
    expect(dup).toEqual({ status: 'duplicate', eventId: 'WH-1' });
    expect(await db().settlementRun.count()).toBe(1);
  });

  it('accepts a webhook that arrives before the capture response, without double-settling', async () => {
    const artifactId = await listedArtifact();
    const { saleId, orderId } = await startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP });
    paypal.approve(orderId);
    // PayPal captured, but our process "crashed" before recording it; the webhook lands first.
    const order = await paypal.captureOrder(orderId, 'external');
    const cap = order.purchase_units![0]!.payments!.captures![0]!;
    const res = await handlePayPalWebhook(db(), paypal, webhook('WH-2', 'PAYMENT.CAPTURE.COMPLETED', cap));
    expect(res).toMatchObject({ status: 'processed', outcome: `sale ${saleId} → captured` });

    const late = await captureSale(db(), paypal, saleId); // ORDER_ALREADY_CAPTURED path
    expect(late.alreadyCaptured).toBe(true);
    expect(await db().settlementRun.count()).toBe(1);
  });

  it('stores but never applies an unverified webhook', async () => {
    const artifactId = await listedArtifact();
    const { saleId } = await startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP });
    const forged = { id: 'CAPTURE-FORGED', status: 'COMPLETED', amount: usd(2000), custom_id: saleId };
    const res = await handlePayPalWebhook(db(), paypal, webhook('WH-3', 'PAYMENT.CAPTURE.COMPLETED', forged, 'forged'));
    expect(res).toEqual({ status: 'rejected', reason: 'signature not verified' });
    expect((await db().sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('pending_payment');
    expect((await db().webhookEvent.findUniqueOrThrow({ where: { id: 'WH-3' } })).verified).toBe(false);
  });

  it('flags a capture whose amount does not match the sale and settles nothing', async () => {
    const artifactId = await listedArtifact();
    const { saleId, orderId } = await startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP });
    paypal.approve(orderId);
    const order = await paypal.captureOrder(orderId, 'external', { amount: usd(1500) });
    const cap = order.purchase_units![0]!.payments!.captures![0]!;
    await handlePayPalWebhook(db(), paypal, webhook('WH-4', 'PAYMENT.CAPTURE.COMPLETED', cap));
    expect((await db().sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('exception');
    expect(await db().settlementRun.count()).toBe(0);
  });

  it('settles under the terms frozen at build time, not a later license edit', async () => {
    const artifactId = await listedArtifact();
    // Northwind raises its royalty to 40% after the report was built.
    const northwind = DEMO_ASSETS.find((a) => a.id === 'asset_northwind_index')!;
    const newTerms: LicenseTerms = { ...northwind.terms, economics: { kind: 'percent_of_gross', bps: 4000 } };
    await db().licenseGrant.update({ where: { id: northwind.licenseId }, data: { status: 'superseded' } });
    await db().licenseGrant.create({
      data: {
        id: 'lic_northwind_v2', assetId: northwind.id, licenseeId: DEMO_IDS.publisher, version: 2, status: 'approved',
        terms: newTerms, termsHash: sha256Hex(canonicalJson(newTerms)), approvedAt: new Date(),
      },
    });

    const { saleId, orderId } = await startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP });
    paypal.approve(orderId);
    const { settlementRunId } = await captureSale(db(), paypal, saleId);
    const line = await db().settlementLine.findFirstOrThrow({ where: { runId: settlementRunId!, recipientId: 'user_northwind' } });
    expect(line).toMatchObject({ amountCents: 500, licenseGrantId: 'lic_northwind_v1' });
  });

  it('requires approval, pays only payable lines, and tracks statuses to completion', async () => {
    const { captured } = await paidSale(paypal);
    const runId = captured.settlementRunId!;

    await expect(submitPayouts(db(), paypal, runId)).rejects.toBeInstanceOf(SettlementStateError);
    await approveSettlement(db(), runId, DEMO_IDS.publisher);

    const batch = await submitPayouts(db(), paypal, runId);
    expect(batch?.status).toBe('PENDING');
    const items = await db().payoutItem.findMany({ where: { batchId: batch!.id } });
    expect(items.map((i) => i.amountCents).sort((a, b) => a - b)).toEqual([200, 300, 500]);

    // Accepted is not paid.
    let refreshed = await refreshPayouts(db(), paypal, runId);
    expect(refreshed.runStatus).toBe('payout_submitted');

    paypal.setAllItems(batch!.paypalBatchId!, 'SUCCESS');
    refreshed = await refreshPayouts(db(), paypal, runId);
    expect(refreshed.runStatus).toBe('completed');
    expect((await db().payoutItem.findMany({ where: { batchId: batch!.id } })).every((i) => i.status === 'SUCCESS')).toBe(true);

    // Submitting again never creates a second batch.
    await submitPayouts(db(), paypal, runId);
    expect(paypal.calls.createPayoutBatch).toBe(1);
  });

  it('turns a failed or returned payout item into an exception', async () => {
    const { captured } = await paidSale(paypal);
    const runId = captured.settlementRunId!;
    await approveSettlement(db(), runId, DEMO_IDS.publisher);
    const batch = await submitPayouts(db(), paypal, runId);
    const [first] = await db().payoutItem.findMany({ where: { batchId: batch!.id } });
    paypal.setAllItems(batch!.paypalBatchId!, 'SUCCESS');
    paypal.setItemStatus(batch!.paypalBatchId!, first!.senderItemId, 'RETURNED');
    expect((await refreshPayouts(db(), paypal, runId)).runStatus).toBe('exception');
  });

  it('never pays twice when the payout response is lost', async () => {
    const { captured } = await paidSale(paypal);
    const runId = captured.settlementRunId!;
    await approveSettlement(db(), runId, DEMO_IDS.publisher);

    paypal.loseNextPayoutResponse = true;
    await expect(submitPayouts(db(), paypal, runId)).rejects.toMatchObject({ code: 'provider' });
    const batch = await db().payoutBatch.findUniqueOrThrow({ where: { runId } });
    expect(batch.status).toBe('SUBMIT_FAILED');

    // Retry reuses the same sender_batch_id; PayPal refuses the duplicate.
    await expect(submitPayouts(db(), paypal, runId)).rejects.toMatchObject({ code: 'provider' });
    expect(paypal.calls.createPayoutBatch).toBe(2);
    expect(paypal.batchIdFor(batch.senderBatchId)).toBeDefined();
    expect((await db().settlementRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('exception');
  });

  it('keeps the settlement queued when the app lacks the Payouts permission', async () => {
    const { captured } = await paidSale(paypal);
    const runId = captured.settlementRunId!;
    await approveSettlement(db(), runId, DEMO_IDS.publisher);
    paypal.payoutsScope = false;
    await expect(submitPayouts(db(), paypal, runId)).rejects.toMatchObject({ code: 'payouts_unavailable' });
    expect((await db().settlementRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('approved');
    expect(await db().payoutBatch.count()).toBe(0);
  });

  it('flags the settlement when PayPal reports a refund', async () => {
    const { checkout, captured } = await paidSale(paypal);
    const refund = {
      id: 'REFUND-1',
      status: 'COMPLETED',
      amount: usd(2000),
      links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captured.captureId}` }],
    };
    const res = await handlePayPalWebhook(db(), paypal, webhook('WH-5', 'PAYMENT.CAPTURE.REFUNDED', refund));
    expect(res.status).toBe('processed');
    expect((await db().sale.findUniqueOrThrow({ where: { id: checkout.saleId } })).status).toBe('refunded');
    expect((await db().settlementRun.findUniqueOrThrow({ where: { saleId: checkout.saleId } })).status).toBe('exception');
    expect(await verifyAuditChain(db())).toMatchObject({ ok: true });
  });

  it('refuses checkout for an unknown artifact', async () => {
    await expect(startCheckout(db(), paypal, { artifactId: 'nope', buyerId: null, appBaseUrl: APP })).rejects.toBeInstanceOf(PaymentError);
  });
});
