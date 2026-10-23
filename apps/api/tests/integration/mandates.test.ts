import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { payWithMandate } from '../../src/modules/agent/mandates.service';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

/**
 * Agentic commerce: the buyer saves PayPal once and sets limits; their shopping assistant then pays on
 * its own within them — and only within them, enforced in code.
 */
describe.runIf(process.env.TEST_DATABASE_URL)('spending mandates (integration)', () => {
  let paypal: FakePayPal;
  let app: ReturnType<typeof testApp>;
  const publisher = { 'X-Demo-User': 'user_atlas' };
  const buyer = { 'X-Demo-User': 'user_buyer' };
  const goal = 'I need a developer tools market brief covering AI coding assistants.';
  let artifactId: string;

  beforeEach(async () => {
    await resetAndSeed(db());
    paypal = new FakePayPal();
    app = testApp(paypal);
    const pre = await request(app)
      .post('/api/builds/preflight')
      .set(publisher)
      .send({
        intent: { title: 'Developer Tools Market Brief, Q4 2026', brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.', purpose: 'commercial_report', distribution: 'sale', includesRawData: false, territory: 'US', priceCents: 2000, currency: 'USD' },
        assetVersionIds: ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'],
      })
      .expect(201);
    artifactId = (await request(app).post(`/api/builds/${pre.body.buildId}/generate`).set(publisher).expect(201)).body.artifactId;
  });

  async function grant(maxPerPurchaseCents = 2500, maxTotalCents = 5000) {
    const started = await request(app).post('/api/shopper/mandate').set(buyer).send({ maxPerPurchaseCents, maxTotalCents, days: 7 }).expect(201);
    expect(started.body.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    // Before the buyer approves at PayPal, nothing can be charged.
    await request(app).post(`/api/shopper/mandate/${started.body.mandateId}/activate`).set(buyer).expect(409);
    const setup = await db().spendingMandate.findUniqueOrThrow({ where: { id: started.body.mandateId } });
    paypal.approveSetupToken(setup.setupTokenId!);
    const { mandate } = (await request(app).post(`/api/shopper/mandate/${started.body.mandateId}/activate`).set(buyer).expect(200)).body;
    expect(mandate).toMatchObject({ status: 'active', maxPerPurchaseCents, maxTotalCents, spentCents: 0, payerEmail: 'buyer@personal.example.com' });
    return mandate.id as string;
  }

  async function shop(budgetCents = 2500) {
    const start = await request(app).post('/api/shopper/runs').set(buyer).send({ goal, budgetCents }).expect(202);
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await request(app).get(`/api/shopper/runs/${start.body.runId}`).set(buyer).expect(200)).body.run;
      if (run.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return run;
  }

  it('lets the assistant pay on its own within the mandate, verified like any sale', async () => {
    const mandateId = await grant();
    const run = await shop();
    expect(run.status).toBe('completed');
    expect(run.summary).toMatch(/you bought the report for \$20\.00/);
    const sale = await db().sale.findFirstOrThrow({ where: { artifactId, buyerId: 'user_buyer' }, include: { payment: true, settlement: true } });
    expect(sale).toMatchObject({ status: 'captured', mandateId });
    expect(sale.payment?.capturedCents).toBe(2000);
    expect(sale.settlement).not.toBeNull(); // contributors' shares worked out as usual
    expect(await db().spendingMandate.findUniqueOrThrow({ where: { id: mandateId } })).toMatchObject({ spentCents: 2000 });
    const step = run.steps.find((s: { tool: string | null; kind: string }) => s.tool === 'propose_purchase' && s.kind === 'tool_result');
    expect(step.output).toMatchObject({ purchased: true, by: 'mandate' });
    expect(JSON.stringify(run)).not.toMatch(/PT-SETUP/); // the vault id never reaches the model or the page
  });

  it('asks the buyer when a purchase is over the mandate', async () => {
    await grant(1500, 5000);
    const run = await shop();
    expect(run.status).toBe('awaiting_approval');
    expect(run.pending.reason).toMatch(/more than your \$15\.00 limit per purchase/);
    expect(await db().sale.count()).toBe(0);
  });

  it('never overspends, even with purchases at the same moment', async () => {
    const mandateId = await grant(2000, 2000);
    const other = await db().artifact.findUniqueOrThrow({ where: { id: artifactId } });
    const second = await db().artifact.create({ data: { ...other, id: 'art_second', buildJobId: (await db().buildJob.create({ data: { ...(await db().buildJob.findUniqueOrThrow({ where: { id: other.buildJobId } })), id: 'bj_second', intent: (await db().buildJob.findUniqueOrThrow({ where: { id: other.buildJobId } })).intent as object, preflight: (await db().buildJob.findUniqueOrThrow({ where: { id: other.buildJobId } })).preflight as object } })).id, content: other.content as object, citationReport: other.citationReport as object } });
    await db().buildSource.createMany({ data: (await db().buildSource.findMany({ where: { buildJobId: other.buildJobId } })).map((s) => ({ ...s, id: undefined, buildJobId: 'bj_second', termsSnapshot: s.termsSnapshot as object })) });
    const results = await Promise.allSettled([artifactId, second.id].map((id) => payWithMandate(db(), paypal, { buyerId: 'user_buyer', artifactId: id, appBaseUrl: 'http://localhost:5173' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db().sale.count({ where: { status: 'captured' } })).toBe(1);
    expect(await db().spendingMandate.findUniqueOrThrow({ where: { id: mandateId } })).toMatchObject({ spentCents: 2000 });
  });

  it('gives the budget back when PayPal declines, and falls back to asking', async () => {
    const mandateId = await grant();
    paypal.declineVaultCharges = true;
    const run = await shop();
    expect(run.status).toBe('awaiting_approval');
    expect(run.pending.reason).toMatch(/PayPal declined the saved payment method/);
    expect(await db().spendingMandate.findUniqueOrThrow({ where: { id: mandateId } })).toMatchObject({ spentCents: 0 });
    expect(await db().sale.count({ where: { status: 'captured' } })).toBe(0);
  });

  it('never calls a charge with a lost reply "failed": it is flagged, and the budget stays reserved', async () => {
    const mandateId = await grant();
    paypal.loseNextVaultReply = true;
    await expect(payWithMandate(db(), paypal, { buyerId: 'user_buyer', artifactId, appBaseUrl: 'http://localhost:5173' })).rejects.toMatchObject({ code: 'unconfirmed' });
    const sale = await db().sale.findFirstOrThrow({ where: { artifactId } });
    expect(sale.status).toBe('exception');
    expect(await db().reconciliationIssue.count({ where: { kind: 'saved_payment_unconfirmed', subjectId: sale.id } })).toBe(1);
    expect(await db().spendingMandate.findUniqueOrThrow({ where: { id: mandateId } })).toMatchObject({ spentCents: 2000 });
  });

  it('says plainly when the PayPal app has no Vault, and charges nothing', async () => {
    paypal.vaultEnabled = false;
    const res = await request(app).post('/api/shopper/mandate').set(buyer).send({ maxPerPurchaseCents: 2500, maxTotalCents: 5000, days: 7 }).expect(502);
    expect(res.body.error).toMatch(/Vault/);
    expect((await request(app).get('/api/shopper/mandate').set(buyer).expect(200)).body.mandate).toBeNull();
  });

  it('stops paying, and removes the saved PayPal, when the buyer revokes', async () => {
    await grant();
    expect(paypal.paymentTokens.size).toBe(1);
    await request(app).delete('/api/shopper/mandate').set(buyer).expect(200);
    expect(paypal.paymentTokens.size).toBe(0);
    const run = await shop();
    expect(run.status).toBe('awaiting_approval');
    expect(await db().sale.count()).toBe(0);
  });
});
