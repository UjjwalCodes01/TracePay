import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { db } from '../../src/db';
import { generateSigningKeys, loadSigningKeys } from '../../src/modules/audit/signing';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FixtureReportWriter } from '../../src/modules/generation/writers';
import { RuleBasedPlanner } from '../../src/modules/agent/planners';
import { FakePayPal } from '../fake-paypal';

const keys = loadSigningKeys(generateSigningKeys().privateKeyB64);

describe.runIf(process.env.TEST_DATABASE_URL)('HTTP demo flow (integration)', () => {
  const paypal = new FakePayPal();
  const app = createApp({
    db: db(),
    paypal: () => paypal,
    signingKeys: () => keys,
    writer: () => new FixtureReportWriter(),
    planner: () => new RuleBasedPlanner(),
    config: { appBaseUrl: 'http://localhost:5173', corsOrigins: ['http://localhost:5173'], paypalClientId: 'test-client', paypalWebhookId: 'WH-ID', vertexReady: false },
  });
  const as = (user: string) => ({ 'X-Demo-User': user });
  const publisher = as('user_atlas');
  const buyer = as('user_buyer');

  const intent = {
    title: 'Developer Tools Market Brief, Q4 2026',
    brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.',
    purpose: 'commercial_report',
    distribution: 'sale',
    includesRawData: false,
    territory: 'US',
    priceCents: 2000,
    currency: 'USD',
  };

  beforeAll(async () => {
    await resetAndSeed(db());
  });

  it('runs block → replace → generate → buy → settle → pay → receipt', async () => {
    // Auth & roles
    await request(app).get('/api/catalog').expect(401);
    await request(app).get('/api/catalog').set(buyer).expect(403);
    const catalog = await request(app).get('/api/catalog').set(publisher).expect(200);
    expect(catalog.body.assets).toHaveLength(5);

    // 1. The compiler blocks the internal-research-only source
    const blocked = await request(app)
      .post('/api/builds/preflight')
      .set(publisher)
      .send({ intent, assetVersionIds: ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_kestrel_panel_v1'] })
      .expect(201);
    expect(blocked.body.report.verdict).toBe('block');
    await request(app).post(`/api/builds/${blocked.body.buildId}/generate`).set(publisher).expect(409);

    // 2. Replace it and pass
    const passed = await request(app)
      .post('/api/builds/preflight')
      .set(publisher)
      .send({ intent, assetVersionIds: ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'] })
      .expect(201);
    expect(passed.body.report.verdict).toBe('pass');

    // 3. Generate
    const gen = await request(app).post(`/api/builds/${passed.body.buildId}/generate`).set(publisher).expect(201);
    const artifactId: string = gen.body.artifactId;

    // Storefront shows a preview; the buyer can't read the full report before paying
    const store = await request(app).get('/api/artifacts').expect(200);
    expect(store.body.artifacts[0]).toMatchObject({ id: artifactId, priceCents: 2000, fromFixture: true });
    expect((await request(app).get(`/api/artifacts/${artifactId}`).set(buyer).expect(200)).body.full).toBe(false);

    // 4. Buy through (fake) PayPal
    const order = await request(app).post('/api/checkout/orders').set(buyer).send({ artifactId }).expect(201);
    await request(app).post(`/api/checkout/${order.body.saleId}/capture`).set(as('user_admin')).expect(403);
    await request(app).post(`/api/checkout/${order.body.saleId}/capture`).set(buyer).expect(409); // not approved yet
    paypal.approve(order.body.orderId);
    const cap = await request(app).post(`/api/checkout/${order.body.saleId}/capture`).set(buyer).expect(200);
    expect(cap.body).toMatchObject({ saleStatus: 'captured', capturedCents: 2000 });
    expect((await request(app).get(`/api/artifacts/${artifactId}`).set(buyer).expect(200)).body.full).toBe(true);

    // 5. Settle and pay
    const runId: string = cap.body.settlementRunId;
    await request(app).post(`/api/settlements/${runId}/payouts`).set(publisher).expect(409); // needs approval
    await request(app).post(`/api/settlements/${runId}/approve`).set(publisher).expect(200);
    const payout = await request(app).post(`/api/settlements/${runId}/payouts`).set(publisher).expect(201);
    paypal.setAllItems(payout.body.batch.paypalBatchId, 'SUCCESS');
    const refreshed = await request(app).post(`/api/settlements/${runId}/refresh`).set(publisher).expect(200);
    expect(refreshed.body.runStatus).toBe('completed');

    // Contributor sees their own record
    const earnings = await request(app).get('/api/contributor/earnings').set(as('user_northwind')).expect(200);
    expect(earnings.body.lines[0]).toMatchObject({ amountCents: 500, payoutItem: { status: 'SUCCESS' } });

    // 6. Provenance graph links sources → passages → sections → artifact → sale → lines → payouts
    const graph = await request(app).get(`/api/artifacts/${artifactId}/provenance`).set(publisher).expect(200);
    const kinds = new Set(graph.body.nodes.map((n: { kind: string }) => n.kind));
    expect([...kinds].sort()).toEqual(['artifact', 'passage', 'payout', 'sale', 'section', 'settlement_line', 'source']);
    expect(graph.body.edges.some((e: { kind: string }) => e.kind === 'supports_claim')).toBe(true);

    // 7. Signed receipt verifies, and fails once tampered with
    const receipt = await request(app).get(`/api/artifacts/${artifactId}/receipt`).set(publisher).expect(200);
    expect(receipt.body.document.chain.verified).toBe(true);
    const ok = await request(app).post('/api/receipts/verify').send({ document: receipt.body.document, signature: receipt.body.signature }).expect(200);
    expect(ok.body.valid).toBe(true);
    const tampered = { ...receipt.body.document, artifact: { ...receipt.body.document.artifact, priceCents: 1 } };
    const bad = await request(app).post('/api/receipts/verify').send({ document: tampered, signature: receipt.body.signature }).expect(200);
    expect(bad.body.valid).toBe(false);

    // Dashboard numbers reconcile
    const dash = await request(app).get('/api/dashboard').set(publisher).expect(200);
    expect(dash.body).toMatchObject({ buildsBlocked: 1, verifiedSales: 1, verifiedSalesCents: 2000, paidOutCents: 1000, unsettledContributorCents: 0, exceptions: 0 });
  });

  it('runs the publisher agent over HTTP with an approval pause', async () => {
    await resetAndSeed(db());
    const start = await request(app)
      .post('/api/agent/runs')
      .set(publisher)
      .send({ goal: 'Create a commercial developer-tools market report from approved sources.', intent, assetVersionIds: ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_kestrel_panel_v1'], autoReplace: false })
      .expect(202);
    const runId: string = start.body.runId;
    const waitFor = async (status: string) => {
      for (let i = 0; i < 50; i++) {
        const r = await request(app).get(`/api/agent/runs/${runId}`).set(publisher).expect(200);
        if (r.body.run.status === status) return r.body.run;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`run never reached ${status}`);
    };
    const paused = await waitFor('awaiting_approval');
    expect(paused.pending.replacementAssetVersionId).toBe('asset_lumen_digest_v1');

    const blockedBuild = paused.builds[0].id;
    const explain = await request(app).get(`/api/builds/${blockedBuild}/explain`).set(publisher).expect(200);
    expect(explain.body).toMatchObject({ verdict: 'block', source: 'rules' });

    await request(app).post(`/api/agent/runs/${runId}/decision`).set(publisher).send({ approved: true }).expect(202);
    const done = await waitFor('completed');
    expect(done.builds.map((b: { status: string }) => b.status)).toEqual(['preflight_blocked', 'generated']);
    await request(app).post(`/api/agent/runs/${runId}/decision`).set(publisher).send({ approved: true }).expect(409);
  });

  it('rejects a webhook with a forged signature over HTTP', async () => {
    const res = await request(app)
      .post('/api/webhooks/paypal')
      .set('Content-Type', 'application/json')
      .set({ 'paypal-auth-algo': 'x', 'paypal-cert-url': 'x', 'paypal-transmission-id': 'x', 'paypal-transmission-sig': 'forged', 'paypal-transmission-time': 'x' })
      .send(JSON.stringify({ id: 'WH-HTTP-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C' } }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'rejected', reason: 'signature not verified' });
  });
});
