import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildIntent, LicenseTerms } from '@tracepay/shared';
import { db } from '../../src/db';
import type { Prisma } from '../../src/generated/prisma/client';
import { createRun } from '../../src/modules/agent/agent.service';
import { RuleBasedPlanner } from '../../src/modules/agent/planners';
import { canonicalJson, sha256Hex } from '../../src/modules/audit/hash-chain';
import { preflightAndRecord } from '../../src/modules/builds/preflight.service';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { DEMO_ASSETS, DEMO_IDS } from '../../src/modules/demo/world';
import { BuildStateError, generateArtifact } from '../../src/modules/generation/generation.service';
import { FixtureReportWriter } from '../../src/modules/generation/writers';
import { recoverStaleWork } from '../../src/modules/maintenance/recovery';
import { captureSale, startCheckout } from '../../src/modules/payments/payments.service';
import { handlePayPalWebhook } from '../../src/modules/payments/webhooks.service';
import { approveSettlement, recalculateSettlement, refreshPayouts, retryFailedPayouts, submitPayouts } from '../../src/modules/settlements/settlement.service';
import { FakePayPal, usd } from '../fake-paypal';
import { TEST_ORIGIN, testApp } from '../test-app';

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
const atlas = { 'X-Demo-User': 'user_atlas' };
const webhook = (id: string, eventType: string, resource: unknown) => ({
  webhookId: 'WH-ID',
  headers: { authAlgo: 'SHA256withRSA', certUrl: 'https://cert', transmissionId: id, transmissionSig: 'valid-signature', transmissionTime: 'now' },
  rawBody: JSON.stringify({ id, event_type: eventType, resource, create_time: '2026-10-18T00:00:00Z' }),
});

async function listedArtifact(ids = [A, B, D]) {
  const { buildId } = await db().$transaction((tx) => preflightAndRecord(tx, { publisherId: DEMO_IDS.publisher, intent, assetVersionIds: ids }));
  return (await generateArtifact(db(), buildId, new FixtureReportWriter())).artifactId!;
}
async function paidSale(paypal: FakePayPal, buyerId: string | null = DEMO_IDS.buyer) {
  const artifactId = await listedArtifact();
  const checkout = await startCheckout(db(), paypal, { artifactId, buyerId, appBaseUrl: APP });
  paypal.approve(checkout.orderId);
  const captured = await captureSale(db(), paypal, checkout.saleId);
  return { artifactId, checkout, captured };
}
async function setTerms(assetId: string, patch: Partial<LicenseTerms>) {
  const a = DEMO_ASSETS.find((x) => x.id === assetId)!;
  const terms = { ...a.terms, ...patch };
  await db().licenseGrant.update({ where: { id: a.licenseId }, data: { terms, termsHash: sha256Hex(canonicalJson(terms)) } });
}

describe.runIf(process.env.TEST_DATABASE_URL)('hardening (integration)', () => {
  let paypal: FakePayPal;
  beforeEach(async () => {
    await resetAndSeed(db());
    paypal = new FakePayPal();
  });

  describe('no private data leaks', () => {
    it('a build — even a blocked one for unlicensed sources — never exposes source text or payout addresses', async () => {
      const app = testApp(paypal, { demoMode: false });
      const rival = request.agent(app);
      await rival.post('/api/auth/signup').send({ email: 'snoop@studio.example', password: 'snoop studio pass', name: 'Snoop', role: 'publisher' }).expect(201);
      const pre = await rival.post('/api/builds/preflight').send({ intent, assetVersionIds: [A, B] }).expect(201);
      expect(pre.body.report.verdict).toBe('block');
      const res = await rival.get(`/api/builds/${pre.body.buildId}`).expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('41.8 billion'); // a sentence from the Northwind dataset
      expect(text).not.toContain('"content"');
      expect(text).not.toContain('payeeEmail');
      expect(text).not.toContain('tracepay-demo.example');
    });

    it('a buyer’s purchase list holds no frozen terms, payout addresses or raw PayPal payloads', async () => {
      const app = testApp(paypal);
      await paidSale(paypal);
      const res = await request(app).get('/api/sales').set({ 'X-Demo-User': 'user_buyer' }).expect(200);
      const text = JSON.stringify(res.body);
      for (const leak of ['termsSnapshot', 'rawCapture', 'payeeEmail', 'tracepay-demo.example', 'settlement']) expect(text).not.toContain(leak);
    });

    it('provenance and receipts are cut to what each viewer is entitled to', async () => {
      const app = testApp(paypal);
      const { artifactId } = await paidSale(paypal);

      const contributor = (await request(app).get(`/api/artifacts/${artifactId}/provenance`).set({ 'X-Demo-User': 'user_northwind' }).expect(200)).body;
      expect(contributor.nodes.filter((n: { kind: string }) => n.kind === 'section').every((n: { data: object }) => !('body' in n.data))).toBe(true);
      const passages = contributor.nodes.filter((n: { kind: string }) => n.kind === 'passage');
      expect(passages.length).toBeGreaterThan(0);
      expect(passages.every((n: { data: { chunkId: string } }) => n.data.chunkId.startsWith('asset_northwind_index'))).toBe(true);
      const lines = contributor.nodes.filter((n: { kind: string }) => n.kind === 'settlement_line');
      expect(lines.map((n: { data: { recipientId: string } }) => n.data.recipientId)).toEqual(['user_northwind']);
      const otherSource = contributor.nodes.find((n: { kind: string; data: { assetVersionId?: string } }) => n.kind === 'source' && n.data.assetVersionId === B);
      expect(otherSource.data.economics).toBeUndefined();

      const buyer = (await request(app).get(`/api/artifacts/${artifactId}/provenance`).set({ 'X-Demo-User': 'user_buyer' }).expect(200)).body;
      expect(buyer.nodes.some((n: { kind: string }) => n.kind === 'settlement_line')).toBe(false);
      expect(buyer.nodes.filter((n: { kind: string }) => n.kind === 'passage').every((n: { data: { text: string } }) => n.data.text.length <= 240)).toBe(true);

      const buyerReceipt = (await request(app).get(`/api/artifacts/${artifactId}/receipt`).set({ 'X-Demo-User': 'user_buyer' }).expect(200)).body;
      expect(buyerReceipt.document.view).toBe('buyer');
      expect(buyerReceipt.document.sales.every((s: { settlement: unknown }) => s.settlement === null)).toBe(true);
      const contribReceipt = (await request(app).get(`/api/artifacts/${artifactId}/receipt`).set({ 'X-Demo-User': 'user_okafor' }).expect(200)).body;
      expect(contribReceipt.document.sales[0].settlement.lines.map((l: { recipientId: string }) => l.recipientId)).toEqual(['user_okafor']);
      expect(contribReceipt.document.sales[0].settlement.lines[0].recipientName).toBe('Mara Okafor (independent analyst)');
      // Each view is still a valid signed document.
      expect((await request(app).post('/api/receipts/verify').send({ document: contribReceipt.document, signature: contribReceipt.signature }).expect(200)).body).toMatchObject({ valid: true, signedBy: 'TracePay' });
    });
  });

  describe('refunds can never be undone or lost', () => {
    it('a COMPLETED webhook redelivered after a refund does not resurrect the sale', async () => {
      const { checkout, captured } = await paidSale(paypal);
      const refund = { id: 'R1', status: 'COMPLETED', amount: usd(2000), links: [{ rel: 'up', href: `https://x/captures/${captured.captureId}` }] };
      await handlePayPalWebhook(db(), paypal, webhook('WH-R1', 'PAYMENT.CAPTURE.REFUNDED', refund));
      const cap = { id: captured.captureId, status: 'COMPLETED', amount: usd(2000), custom_id: checkout.saleId };
      await handlePayPalWebhook(db(), paypal, webhook('WH-C1', 'PAYMENT.CAPTURE.COMPLETED', cap));
      await captureSale(db(), paypal, checkout.saleId);
      expect((await db().sale.findUniqueOrThrow({ where: { id: checkout.saleId } })).status).toBe('refunded');
    });

    it('a refund that arrives before the capture is recorded is retried, not dropped', async () => {
      const artifactId = await listedArtifact();
      const { saleId, orderId } = await startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP });
      paypal.approve(orderId);
      const cap = (await paypal.captureOrder(orderId, 'external')).purchase_units![0]!.payments!.captures![0]!;
      const refund = { id: 'R2', status: 'COMPLETED', amount: usd(2000), links: [{ rel: 'up', href: `https://x/captures/${cap.id}` }] };
      const early = await handlePayPalWebhook(db(), paypal, webhook('WH-R2', 'PAYMENT.CAPTURE.REFUNDED', refund));
      expect(early.status).toBe('failed'); // → HTTP 500 → PayPal redelivers later
      await handlePayPalWebhook(db(), paypal, webhook('WH-C2', 'PAYMENT.CAPTURE.COMPLETED', cap));
      const redelivered = await handlePayPalWebhook(db(), paypal, webhook('WH-R2', 'PAYMENT.CAPTURE.REFUNDED', refund));
      expect(redelivered.status).toBe('processed');
      expect((await db().sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('refunded');
      await expect(approveSettlement(db(), (await db().settlementRun.findUniqueOrThrow({ where: { saleId } })).id, DEMO_IDS.publisher)).rejects.toThrow();
    });

    it('a partial refund makes the sale an exception rather than "refunded"', async () => {
      const { checkout, captured } = await paidSale(paypal);
      const refund = { id: 'R3', status: 'COMPLETED', amount: usd(500), links: [{ rel: 'up', href: `https://x/captures/${captured.captureId}` }] };
      await handlePayPalWebhook(db(), paypal, webhook('WH-R3', 'PAYMENT.CAPTURE.REFUNDED', refund));
      expect((await db().sale.findUniqueOrThrow({ where: { id: checkout.saleId } })).status).toBe('exception');
    });
  });

  describe('licenses that change after a report is built', () => {
    it('revoking also closes a pending offer, so accepting it cannot undo the revocation', async () => {
      const app = testApp(paypal);
      const grant = DEMO_ASSETS[0]!;
      const offer = await request(app)
        .post(`/api/contributor/assets/${grant.id}/offers`)
        .set({ 'X-Demo-User': 'user_northwind' })
        .send({ licenseeEmail: 'studio@atlas-research.example', terms: { ...grant.terms, economics: { kind: 'percent_of_gross', bps: 2000 } } })
        .expect(201);
      await request(app).post(`/api/licenses/${grant.licenseId}/revoke`).set({ 'X-Demo-User': 'user_northwind' }).send({}).expect(200);
      await request(app).post(`/api/licenses/${offer.body.license.id}/accept`).set(atlas).send({ termsHash: offer.body.license.termsHash }).expect(409);
    });

    it('renegotiated terms that newly require a credit stop sales of a report without it', async () => {
      const artifactId = await listedArtifact([A, D]);
      await setTerms('asset_northwind_index', { derivativeReports: 'allowed_with_attribution', attributionText: 'Data: Northwind' });
      await expect(startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP })).rejects.toMatchObject({ code: 'not_for_sale' });
      expect((await db().artifact.findUniqueOrThrow({ where: { id: artifactId } })).status).toBe('withdrawn');
    });

    it('re-checks licenses at generation time, before any source text is read', async () => {
      const { buildId } = await db().$transaction((tx) => preflightAndRecord(tx, { publisherId: DEMO_IDS.publisher, intent, assetVersionIds: [A, D] }));
      await db().licenseGrant.update({ where: { id: DEMO_ASSETS[0]!.licenseId }, data: { status: 'revoked' } });
      await expect(generateArtifact(db(), buildId, new FixtureReportWriter())).rejects.toBeInstanceOf(BuildStateError);
      expect((await db().buildJob.findUniqueOrThrow({ where: { id: buildId } })).status).toBe('generation_failed');
      expect(await db().sourceEvent.count({ where: { buildJobId: buildId } })).toBe(0);
    });

    it('re-checks right before capture: a license revoked while the buyer is in PayPal means no charge', async () => {
      const artifactId = await listedArtifact();
      const { saleId, orderId } = await startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP });
      paypal.approve(orderId);
      await db().licenseGrant.update({ where: { id: DEMO_ASSETS[0]!.licenseId }, data: { status: 'revoked' } });
      await expect(captureSale(db(), paypal, saleId)).rejects.toMatchObject({ code: 'not_for_sale' });
      expect(paypal.calls.captureOrder).toBe(0);
      expect((await db().sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('payment_failed');
    });

    it('a stored license with terms that no longer validate blocks cleanly instead of crashing', async () => {
      const a = DEMO_ASSETS[0]!;
      await db().licenseGrant.update({ where: { id: a.licenseId }, data: { terms: { ...a.terms, allowedPurposes: ['internal_research'] } } });
      const app = testApp(paypal);
      await request(app).get('/api/catalog').set(atlas).expect(200);
      const pre = await request(app).post('/api/builds/preflight').set(atlas).send({ intent, assetVersionIds: [A] }).expect(201);
      expect(pre.body.report.results.find((r: { ruleId: string }) => r.ruleId === 'LICENSE_PRESENT').message).toMatch(/no longer pass validation/);
    });
  });

  describe('payout recovery', () => {
    it('retries only failed items, to the contributor’s corrected address, keeping history', async () => {
      const { captured } = await paidSale(paypal);
      const runId = captured.settlementRunId!;
      await approveSettlement(db(), runId, DEMO_IDS.publisher);
      const batch = await submitPayouts(db(), paypal, runId);
      const items = await db().payoutItem.findMany({ where: { batchId: batch!.id }, include: { settlementLine: true } });
      const northwind = items.find((i) => i.settlementLine.recipientId === 'user_northwind')!;
      paypal.setAllItems(batch!.paypalBatchId!, 'SUCCESS');
      paypal.setItemStatus(batch!.paypalBatchId!, northwind.senderItemId, 'RETURNED');
      expect((await refreshPayouts(db(), paypal, runId)).runStatus).toBe('exception');

      await db().user.update({ where: { id: 'user_northwind' }, data: { paypalEmail: 'fixed@northwind.example' } });
      const retry = await retryFailedPayouts(db(), paypal, runId);
      expect(retry).toMatchObject({ attempt: 2, status: 'PENDING' });
      const moved = await db().payoutItem.findUniqueOrThrow({ where: { id: northwind.id } });
      expect(moved).toMatchObject({ batchId: retry!.id, receiver: 'fixed@northwind.example' });
      expect((moved.attempts as unknown[]).length).toBe(1);

      paypal.setAllItems(retry!.paypalBatchId!, 'SUCCESS');
      expect((await refreshPayouts(db(), paypal, runId)).runStatus).toBe('completed');
      await expect(retryFailedPayouts(db(), paypal, runId)).rejects.toThrow(/no failed payouts/);
    });

    it('recalculates a settlement whose calculation failed once the cause is fixed', async () => {
      const artifactId = await listedArtifact();
      const { saleId, orderId } = await startCheckout(db(), paypal, { artifactId, buyerId: null, appBaseUrl: APP });
      const sale = await db().sale.findUniqueOrThrow({ where: { id: saleId } });
      const snapshot = (sale.termsSnapshot as Array<Record<string, unknown>>).map((t) => (t.contributorId === 'user_northwind' ? { ...t, payeeEmail: null } : t));
      await db().sale.update({ where: { id: saleId }, data: { termsSnapshot: snapshot as Prisma.InputJsonValue } });
      paypal.approve(orderId);
      const res = await captureSale(db(), paypal, saleId);
      const failed = await db().settlementRun.findUniqueOrThrow({ where: { id: res.settlementRunId! } });
      expect(failed).toMatchObject({ status: 'exception' });
      expect(failed.failureReason).toMatch(/no payee/);

      const fresh = await recalculateSettlement(db(), failed.id);
      expect(fresh.status).toBe('calculated');
      const line = await db().settlementLine.findFirstOrThrow({ where: { runId: fresh.id, recipientId: 'user_northwind' } });
      expect(line.payeeEmail).toBeTruthy();
    });
  });

  describe('interrupted work', () => {
    it('marks long-silent runs interrupted, and a late-finishing loop cannot overwrite that', async () => {
      const run = await createRun(db(), new RuleBasedPlanner(), { publisherId: DEMO_IDS.publisher, goal: 'Build a report please', intent, selection: [A], policy: { autoReplace: false } });
      await db().$executeRaw`UPDATE "AgentRun" SET "updatedAt" = now() - interval '1 hour' WHERE id = ${run.id}`;
      const { buildId } = await db().$transaction((tx) => preflightAndRecord(tx, { publisherId: DEMO_IDS.publisher, intent, assetVersionIds: [A, D] }));
      await db().$executeRaw`UPDATE "BuildJob" SET status = 'generating', "updatedAt" = now() - interval '1 hour' WHERE id = ${buildId}`;

      expect(await recoverStaleWork(db())).toEqual({ agentRuns: 1, builds: 1, answers: 0 });
      expect((await db().agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('failed');
      expect((await db().buildJob.findUniqueOrThrow({ where: { id: buildId } })).status).toBe('generation_failed');
      expect(await recoverStaleWork(db())).toEqual({ agentRuns: 0, builds: 0, answers: 0 });
    });
  });

  describe('demo mode safety', () => {
    it('“Reset demo” restores the demo but never touches real accounts or their data', async () => {
      const app = testApp(paypal);
      const real = request.agent(app);
      await real.post('/api/auth/signup').send({ email: 'keep@studio.example', password: 'keep studio pass', name: 'Keep Studio', role: 'publisher' }).expect(201);
      const realBuild = await real.post('/api/builds/preflight').send({ intent, assetVersionIds: [A] }).expect(201);
      await paidSale(paypal); // demo publisher work that should be cleared

      await request(app).post('/api/demo/reset').set(atlas).expect(200);
      expect(await db().user.count({ where: { email: 'keep@studio.example' } })).toBe(1);
      expect(await db().buildJob.count({ where: { id: realBuild.body.buildId } })).toBe(1);
      await real.get('/api/me').expect(200); // the real session survived
      expect(await db().buildJob.count({ where: { publisherId: DEMO_IDS.publisher } })).toBe(0);
      expect(await db().licenseGrant.count({ where: { licenseeId: DEMO_IDS.publisher, status: 'approved' } })).toBe(5);
    });

    it('the demo header can only assume seeded personas, never a real account', async () => {
      const app = testApp(paypal);
      const res = await request(app).post('/api/auth/signup').send({ email: 'target@studio.example', password: 'target studio pass', name: 'Target', role: 'publisher' }).expect(201);
      await request(app).get('/api/me').set({ 'X-Demo-User': res.body.user.id }).expect(401);
      await request(app).post('/api/auth/signup').send({ email: 'studio@atlas-research.example', password: 'squatting pass', name: 'Squat', role: 'publisher' }).expect(409);
    });
  });

  describe('request hardening', () => {
    it('refuses cross-site browser writes even without an Origin header', async () => {
      const app = testApp(paypal);
      await request(app).post('/api/builds/preflight').set(atlas).set('Sec-Fetch-Site', 'cross-site').send({ intent, assetVersionIds: [A] }).expect(403);
      await request(app).post('/api/builds/preflight').set(atlas).set('Origin', TEST_ORIGIN).set('Sec-Fetch-Site', 'same-origin').send({ intent, assetVersionIds: [A] }).expect(201);
    });

    it('locks an account after repeated failed logins, whatever the IP', async () => {
      const app = testApp(paypal, { demoMode: false });
      await request(app).post('/api/auth/signup').send({ email: 'locked@studio.example', password: 'locked studio pass', name: 'Locked', role: 'buyer' }).expect(201);
      for (let i = 0; i < 10; i++) await request(app).post('/api/auth/login').set('X-Forwarded-For', `10.0.0.${i}`).send({ email: 'locked@studio.example', password: 'wrong guess' }).expect(401);
      await request(app).post('/api/auth/login').send({ email: 'locked@studio.example', password: 'locked studio pass' }).expect(429);
    });

    it('reuses a buyer’s open checkout instead of creating new sales and PayPal orders', async () => {
      const artifactId = await listedArtifact();
      const first = await startCheckout(db(), paypal, { artifactId, buyerId: DEMO_IDS.buyer, appBaseUrl: APP });
      const again = await startCheckout(db(), paypal, { artifactId, buyerId: DEMO_IDS.buyer, appBaseUrl: APP });
      expect(again).toMatchObject({ saleId: first.saleId, orderId: first.orderId });
      expect(paypal.calls.createOrder).toBe(1);
    });

    it('rejects prices above the supported maximum before any model call', async () => {
      const app = testApp(paypal);
      await request(app).post('/api/builds/preflight').set(atlas).send({ intent: { ...intent, priceCents: 5_000_000_000 }, assetVersionIds: [A] }).expect(400);
    });
  });
});
