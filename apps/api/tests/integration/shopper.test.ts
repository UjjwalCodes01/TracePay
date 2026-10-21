import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { executeShopperTool, matchScore } from '../../src/modules/agent/buyer-tools';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

describe('matchScore', () => {
  it('scores word overlap and ignores filler words', () => {
    expect(matchScore('a report about developer tools', 'Developer Tools Market Brief')).toBe(1);
    expect(matchScore('developer pricing', 'Developer Tools Market Brief')).toBe(0.5);
    expect(matchScore('please find a report', 'Developer Tools Market Brief')).toBe(0);
  });
});

describe.runIf(process.env.TEST_DATABASE_URL)('Shopping Assistant (integration)', () => {
  const paypal = new FakePayPal();
  const app = testApp(paypal);
  const publisher = { 'X-Demo-User': 'user_atlas' };
  const buyer = { 'X-Demo-User': 'user_buyer' };
  const goal = 'I need a developer tools market brief covering AI coding assistants.';
  let artifactId: string;

  beforeEach(async () => {
    await resetAndSeed(db());
    const passed = await request(app)
      .post('/api/builds/preflight')
      .set(publisher)
      .send({
        intent: {
          title: 'Developer Tools Market Brief, Q4 2026',
          brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.',
          purpose: 'commercial_report',
          distribution: 'sale',
          includesRawData: false,
          territory: 'US',
          priceCents: 2000,
          currency: 'USD',
        },
        assetVersionIds: ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'],
      })
      .expect(201);
    artifactId = (await request(app).post(`/api/builds/${passed.body.buildId}/generate`).set(publisher).expect(201)).body.artifactId;
  });

  /** Runs work in the background: wait until one settles into `status`. */
  async function until(runId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const { body } = await request(app).get(`/api/shopper/runs/${runId}`).set(buyer).expect(200);
      if (body.run.status === status) return body.run;
      if (body.run.status === 'failed') throw new Error(`run failed: ${body.run.summary}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`run never reached ${status}`);
  }

  it('finds a report, checks it, and buys it only after the buyer pays in PayPal', async () => {
    const start = await request(app).post('/api/shopper/runs').set(buyer).send({ goal, budgetCents: 2500 }).expect(202);
    const paused = await until(start.body.runId, 'awaiting_approval');
    expect(paused.pending).toMatchObject({ artifactId, priceCents: 2000, currency: 'USD' });
    expect(paused.pending.reason).toMatch(/licensed for sale today/);
    expect(paused.pending).not.toHaveProperty('callId'); // bookkeeping stays inside
    expect(paused.steps.map((s: { tool: string | null }) => s.tool)).toEqual(expect.arrayContaining(['search_reports', 'inspect_report', 'propose_purchase']));

    // "Yes" means nothing until PayPal has the money.
    await request(app).post(`/api/shopper/runs/${start.body.runId}/decision`).set(buyer).send({ approved: true }).expect(409);

    const order = await request(app).post('/api/checkout/orders').set(buyer).send({ artifactId }).expect(201);
    paypal.approve(order.body.orderId);
    await request(app).post(`/api/checkout/${order.body.saleId}/capture`).set(buyer).expect(200);
    await request(app).post(`/api/shopper/runs/${start.body.runId}/decision`).set(buyer).send({ approved: true }).expect(202);
    await request(app).post(`/api/shopper/runs/${start.body.runId}/decision`).set(buyer).send({ approved: true }).expect(409); // only once

    const done = await until(start.body.runId, 'completed');
    expect(done.summary).toMatch(/you bought the report for \$20\.00/);
    expect(done.summary).toMatch(/Budget left: \$5\.00/);
    // The completion is recorded in the audit log just after the run is marked done.
    let events: { eventType: string }[] = [];
    for (let i = 0; i < 40 && !events.some((e) => e.eventType === 'agent.completed'); i++) {
      events = await db().auditEvent.findMany({ where: { entityId: start.body.runId }, select: { eventType: true } });
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['agent.started', 'agent.awaiting_approval', 'agent.purchase_approved', 'agent.completed']));
  });

  it('never proposes a report over the budget', async () => {
    const start = await request(app).post('/api/shopper/runs').set(buyer).send({ goal, budgetCents: 500 }).expect(202);
    const done = await until(start.body.runId, 'completed');
    expect(done.summary).toMatch(/none fits your remaining budget of \$5\.00/);
    expect(await db().sale.count({ where: { buyerId: 'user_buyer' } })).toBe(0);
  });

  it('stops without buying when the buyer says no', async () => {
    const start = await request(app).post('/api/shopper/runs').set(buyer).send({ goal, budgetCents: 2500 }).expect(202);
    await until(start.body.runId, 'awaiting_approval');
    await request(app).post(`/api/shopper/runs/${start.body.runId}/decision`).set(buyer).send({ approved: false }).expect(202);
    const done = await until(start.body.runId, 'completed');
    expect(done.summary).toMatch(/nothing was bought/);
  });

  it('enforces the guardrails in code, whatever the model asks for', async () => {
    const run = await db().agentRun.create({
      data: { kind: 'buyer', publisherId: 'user_buyer', goal, policy: { budgetCents: 1000, maxPurchases: 1 }, intent: {}, selection: [] },
    });
    const ctx = { db: db(), runId: run.id, buyerId: 'user_buyer', policy: { budgetCents: 1000, maxPurchases: 1 }, purchases: [] };
    expect((await executeShopperTool(ctx, 'propose_purchase', { reportId: artifactId, reason: 'Fits.' })).response).toMatchObject({ error: 'GUARDRAIL' });
    const spent = { ...ctx, policy: { budgetCents: 5000, maxPurchases: 1 }, purchases: [{ artifactId: 'x', amountCents: 100 }] };
    expect((await executeShopperTool(spent, 'propose_purchase', { reportId: artifactId, reason: 'Fits.' })).response).toMatchObject({ error: 'GUARDRAIL' });
    await db().artifact.update({ where: { id: artifactId }, data: { status: 'withdrawn' } });
    const roomy = { ...ctx, policy: { budgetCents: 5000, maxPurchases: 1 } };
    expect((await executeShopperTool(roomy, 'propose_purchase', { reportId: artifactId, reason: 'Fits.' })).response).toMatchObject({ error: 'GUARDRAIL' });
  });

  it('keeps shopping runs to the buyer, and out of the publisher’s agent screens', async () => {
    const start = await request(app).post('/api/shopper/runs').set(buyer).send({ goal, budgetCents: 500 }).expect(202);
    await until(start.body.runId, 'completed');
    await request(app).post('/api/shopper/runs').set(publisher).send({ goal, budgetCents: 500 }).expect(403);
    await request(app).get(`/api/agent/runs/${start.body.runId}`).set(publisher).expect(404);
    expect((await request(app).get('/api/agent/runs').set(publisher).expect(200)).body.runs).toHaveLength(0);
    expect((await request(app).get('/api/shopper/runs').set(buyer).expect(200)).body.runs).toHaveLength(1);
    await request(app).post('/api/shopper/runs').set(buyer).send({ goal: 'short', budgetCents: 500 }).expect(400);
    await request(app).post('/api/shopper/runs').set(buyer).send({ goal, budgetCents: 10_000_000 }).expect(400);
  });
});
