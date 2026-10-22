import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { refillDemoCredit } from '../../src/modules/answers/credits.service';
import { DEMO_CREDIT_CENTS } from '../../src/modules/demo/soft-reset';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

/**
 * A hosted demo (DEMO_SHARED_BUYER): every visitor shares the demo buyer, so each one can still
 * try buying a report and asking a question — without that weakening any rule for real accounts.
 */
describe.runIf(process.env.TEST_DATABASE_URL)('a demo shared by many visitors', () => {
  let paypal: FakePayPal;
  const publisher = { 'X-Demo-User': 'user_atlas' };
  const buyer = { 'X-Demo-User': 'user_buyer' };
  const goal = 'I need a developer tools market brief covering AI coding assistants.';
  const app = (shared: boolean) => testApp(paypal, { demoSharedBuyer: shared });

  beforeEach(async () => {
    await resetAndSeed(db());
    paypal = new FakePayPal();
  });

  async function listedReport(a: ReturnType<typeof app>) {
    const passed = await request(a)
      .post('/api/builds/preflight')
      .set(publisher)
      .send({
        intent: { title: 'Developer Tools Market Brief, Q4 2026', brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.', purpose: 'commercial_report', distribution: 'sale', includesRawData: false, territory: 'US', priceCents: 2000, currency: 'USD' },
        assetVersionIds: ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'],
      })
      .expect(201);
    return (await request(a).post(`/api/builds/${passed.body.buildId}/generate`).set(publisher).expect(201)).body.artifactId as string;
  }

  async function buy(a: ReturnType<typeof app>, artifactId: string) {
    const order = await request(a).post('/api/checkout/orders').set(buyer).send({ artifactId });
    if (order.status !== 201) return order;
    paypal.approve(order.body.orderId);
    return request(a).post(`/api/checkout/${order.body.saleId}/capture`).set(buyer).expect(200);
  }

  it('lets the shared buyer buy a report again; anyone else still can’t pay twice', async () => {
    const shared = app(true);
    const artifactId = await listedReport(shared);
    expect((await buy(shared, artifactId)).body.saleStatus).toBe('captured');
    expect((await buy(shared, artifactId)).body.saleStatus).toBe('captured');
    expect(await db().sale.count({ where: { artifactId, status: 'captured' } })).toBe(2);
    // Each sale is split and paid on its own.
    expect(await db().settlementRun.count({ where: { sale: { artifactId } } })).toBe(2);

    const normal = app(false);
    const again = await buy(normal, artifactId);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already own/);
  });

  it('tops the shared buyer’s demo credit back up, and keeps the ledger exact', async () => {
    expect((await request(app(false)).get('/api/credits').set(buyer).expect(200)).body.balanceCents).toBe(0);
    const credits = (await request(app(true)).get('/api/credits').set(buyer).expect(200)).body;
    expect(credits).toMatchObject({ balanceCents: DEMO_CREDIT_CENTS, availableCents: DEMO_CREDIT_CENTS });
    expect(credits.entries).toEqual([expect.objectContaining({ kind: 'demo_credit', amountCents: DEMO_CREDIT_CENTS })]);
    // Plenty left: no second refill.
    await request(app(true)).get('/api/credits').set(buyer).expect(200);
    const account = await db().creditAccount.findUniqueOrThrow({ where: { ownerId: 'user_buyer' } });
    const sum = await db().creditEntry.aggregate({ where: { accountId: account.id }, _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(account.balanceCents);
    expect(account.balanceCents).toBe(DEMO_CREDIT_CENTS);
    // Never for a real account.
    const real = await db().user.create({ data: { email: 'real-buyer@example.com', name: 'Real Buyer', role: 'buyer' } });
    await refillDemoCredit(db(), real.id);
    expect(await db().creditAccount.count({ where: { ownerId: real.id } })).toBe(0);
  });

  it('lets the shopping assistant propose a report an earlier visitor bought, and only this visitor’s payment counts', async () => {
    const a = app(true);
    const artifactId = await listedReport(a);
    await buy(a, artifactId); // an earlier visitor

    const start = await request(a).post('/api/shopper/runs').set(buyer).send({ goal, budgetCents: 2500 }).expect(202);
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await request(a).get(`/api/shopper/runs/${start.body.runId}`).set(buyer).expect(200)).body.run;
      if (run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run.status).toBe('awaiting_approval');
    // The earlier visitor's purchase doesn't count as this one.
    expect(run.pending).toMatchObject({ artifactId, payment: null });
    await request(a).post(`/api/shopper/runs/${start.body.runId}/decision`).set(buyer).send({ approved: true }).expect(409);

    expect((await buy(a, artifactId)).body.saleStatus).toBe('captured');
    for (let i = 0; i < 100 && run.status !== 'completed'; i++) {
      run = (await request(a).get(`/api/shopper/runs/${start.body.runId}`).set(buyer).expect(200)).body.run;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run.status).toBe('completed');
    expect(run.summary).toMatch(/you bought the report for \$20\.00/);
  });
});
