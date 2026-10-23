import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { createApp } from '../../src/app';
import { auditAnswer, MAX_PAID_PASSAGES_PER_SOURCE, planWithinBudget, runRedTeam, supports } from '../../src/modules/answers/integrity';
import { answerFeeCents, releaseStaleAnswers } from '../../src/modules/answers/answers.service';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { softResetDemo, DEMO_CREDIT_CENTS } from '../../src/modules/demo/soft-reset';
import { FixtureAnswerWriter, type AnswerWriter } from '../../src/modules/generation/writers';
import { handlePayPalWebhook } from '../../src/modules/payments/webhooks.service';
import { FakePayPal } from '../fake-paypal';
import { testDeps } from '../test-app';
import { createApiKey } from '../../src/modules/auth/auth.service';

const QUESTION = 'How fast is spending on AI coding assistants growing, and how many developers use an assistant weekly?';

describe('pay-per-citation rules (unit)', () => {
  it('catches every red-team attack, and never pays for a citation the answer did not use', () => {
    const results = runRedTeam();
    expect(results.filter((r) => !r.caught)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(7);
  });

  it('pays a supported citation and not a decorative one', () => {
    expect(supports('Assistant spend rose 61% year over year [C1].', 'AI coding assistants were the fastest-growing category, up 61% year over year.')).toBe(true);
    expect(supports('The weather was lovely [C1].', 'AI coding assistants were the fastest-growing category, up 61% year over year.')).toBe(false);
  });

  it('never plans an answer that could cost more than the limit', () => {
    for (const limit of [1, 2, 3, 5, 8, 13, 21, 40]) {
      const plan = planWithinBudget(
        [
          { assetVersionId: 'a', centsPerCitation: 3, passages: [1, 2, 3].map((n) => ({ handle: '', chunkId: `a${n}`, assetVersionId: 'a', text: 't' })) },
          { assetVersionId: 'b', centsPerCitation: 2, passages: [1, 2, 3].map((n) => ({ handle: '', chunkId: `b${n}`, assetVersionId: 'b', text: 't' })) },
          { assetVersionId: 'c', centsPerCitation: 0, passages: [1].map((n) => ({ handle: '', chunkId: `c${n}`, assetVersionId: 'c', text: 't' })) },
        ],
        1,
        limit,
      );
      expect(plan.worstCaseCents).toBeLessThanOrEqual(Math.max(limit, 1));
    }
  });

  it('caps paid passages per source', () => {
    const passages = [1, 2, 3, 4, 5].map((n) => ({ handle: `C${n}`, chunkId: `x${n}`, assetVersionId: 'x', text: `Assistant spend grew ${n}1% this quarter.` }));
    const text = passages.map((p, i) => `Assistant spend grew ${i + 1}1% this quarter [${p.handle}].`).join(' ');
    expect(auditAnswer(text, passages, [{ assetVersionId: 'x', centsPerCitation: 2 }]).contributorCents).toBe(2 * MAX_PAID_PASSAGES_PER_SOURCE);
  });
});

describe.runIf(process.env.TEST_DATABASE_URL)('pay-per-citation answers (integration)', () => {
  let paypal: FakePayPal;
  let writer: AnswerWriter | null;
  const buyer = { 'X-Demo-User': 'user_buyer' };
  const publisher = { 'X-Demo-User': 'user_atlas' };
  const app = () => {
    const deps = testDeps(paypal);
    return createApp({ ...deps, answerWriter: () => writer ?? deps.answerWriter() });
  };
  const ask = (a: ReturnType<typeof app>, body: Record<string, unknown> = {}) =>
    request(a).post('/api/answers').set(buyer).send({ libraryId: 'user_atlas', question: QUESTION, maxPriceCents: 50, ...body });

  async function topUp(a: ReturnType<typeof app>, amountCents = 500) {
    const started = await request(a).post('/api/credits/top-ups').set(buyer).send({ amountCents }).expect(201);
    paypal.approve(started.body.orderId);
    return (await request(a).post(`/api/credits/top-ups/${started.body.topUpId}/capture`).set(buyer).expect(200)).body;
  }

  /** The ledger is the truth: entries always sum to the balance, and nothing stays reserved. */
  async function expectLedgerConsistent() {
    const account = await db().creditAccount.findUniqueOrThrow({ where: { ownerId: 'user_buyer' } });
    const sum = await db().creditEntry.aggregate({ where: { accountId: account.id }, _sum: { amountCents: true } });
    expect(sum._sum.amountCents ?? 0).toBe(account.balanceCents);
    expect(account.reservedCents).toBe(0);
    return account;
  }

  beforeEach(async () => {
    await resetAndSeed(db());
    paypal = new FakePayPal();
    writer = null;
  });

  it('answers only from sources licensed for AI, charges for verified citations and credits their contributors', async () => {
    const a = app();
    // No credit yet: payment required.
    const broke = await ask(a).expect(402);
    expect(broke.body.error).toMatch(/Top up/);

    const topped = await topUp(a, 500);
    expect(topped).toMatchObject({ status: 'captured', amountCents: 500 });
    expect((await request(a).get('/api/credits').set(buyer).expect(200)).body).toMatchObject({ balanceCents: 500, availableCents: 500 });

    const { answer } = (await ask(a).expect(201)).body;
    expect(answer.status).toBe('answered');
    expect(answer.fromFixture).toBe(true);
    expect(answer.text).toMatch(/\[C\d+\]/);
    // Rights: the internal-only panel says no to AI, the pricing tracker's license has expired.
    expect(answer.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Kestrel Enterprise Engineering Panel 2026', code: 'ai_not_allowed' }),
        expect.objectContaining({ title: 'Cloud IDE Pricing Tracker Q2 2026', code: 'out_of_term' }),
      ]),
    );
    expect(answer.paid.map((p: { title: string }) => p.title)).not.toContain('Kestrel Enterprise Engineering Panel 2026');
    // The charge is exactly the fee plus what contributors earned, within the limit.
    const earned = answer.paid.reduce((n: number, p: { amountCents: number }) => n + p.amountCents, 0);
    expect(earned).toBeGreaterThan(0);
    expect(answer.chargedCents).toBe(answerFeeCents() + earned);
    expect(answer.chargedCents).toBeLessThanOrEqual(50);
    for (const p of answer.paid) expect(p.amountCents).toBe(p.citations * p.centsPerCitation);

    // The signed receipt verifies, and a tampered one does not.
    const { document, signature } = answer.receipt;
    expect((await request(a).post('/api/receipts/verify').send({ document, signature }).expect(200)).body.valid).toBe(true);
    expect((await request(a).post('/api/receipts/verify').send({ document: { ...document, chargedCents: 0 }, signature }).expect(200)).body.valid).toBe(false);

    const account = await expectLedgerConsistent();
    expect(account.balanceCents).toBe(500 - answer.chargedCents);
    // Contributors see what they earned.
    const okafor = (await request(a).get('/api/contributor/answer-earnings').set({ 'X-Demo-User': 'user_northwind' }).expect(200)).body;
    expect(okafor.owedCents).toBe(answer.paid.find((p: { title: string }) => p.title.startsWith('Northwind'))?.amountCents ?? 0);
    // Audit trail.
    expect(await db().auditEvent.count({ where: { entityType: 'answer', entityId: answer.id, eventType: 'answer.answered' } })).toBe(1);
  });

  it('enforces the asker’s price limit before the model runs', async () => {
    const a = app();
    await topUp(a);
    const fee = answerFeeCents();
    await ask(a, { maxPriceCents: fee - 1 || 0 }).expect(400);
    const { answer } = (await ask(a, { maxPriceCents: fee + 3 }).expect(201)).body;
    expect(answer.chargedCents).toBeLessThanOrEqual(fee + 3);
    expect(answer.excluded.some((e: { code: string }) => e.code === 'over_budget')).toBe(true);
    await expectLedgerConsistent();
  });

  it('charges nothing when the licensed library doesn’t cover the question', async () => {
    const a = app();
    await topUp(a);
    const { answer } = (await ask(a, { question: 'What is the best recipe for sourdough bread?' }).expect(201)).body;
    expect(answer).toMatchObject({ status: 'not_covered', chargedCents: 0, paid: [] });
    const account = await expectLedgerConsistent();
    expect(account.balanceCents).toBe(500);
  });

  it('rejects an answer that invents a source, and charges nothing', async () => {
    writer = { name: 'liar', answer: async () => ({ covered: true, text: 'Spend grew 61% [C1]. A secret source says 90% [C99].', model: 'test', fromFixture: false }) };
    const a = app();
    await topUp(a);
    const { answer } = (await ask(a).expect(201)).body;
    expect(answer).toMatchObject({ status: 'failed', chargedCents: 0, paid: [] });
    expect(answer.failureReason).toMatch(/cited sources it wasn’t given/);
    await expectLedgerConsistent();
  });

  it('charges nothing when the model is unreachable', async () => {
    writer = { name: 'down', answer: async () => { throw new Error('model unavailable'); } };
    const a = app();
    await topUp(a);
    const { answer } = (await ask(a).expect(201)).body;
    expect(answer).toMatchObject({ status: 'failed', chargedCents: 0 });
    await expectLedgerConsistent();
  });

  it('stops using a source the moment its license is revoked', async () => {
    const a = app();
    await topUp(a);
    await db().licenseGrant.update({ where: { id: 'lic_northwind_v1' }, data: { status: 'revoked' } });
    const { answer } = (await ask(a).expect(201)).body;
    expect(answer.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Northwind DevTools Spend Index 2026', code: 'revoked' })]));
    expect(answer.paid.map((p: { title: string }) => p.title)).not.toContain('Northwind DevTools Spend Index 2026');
  });

  it('applies the real papers’ own licenses: CC BY used for free, non-commercial and no-derivatives left out, unlicensed never read', async () => {
    const a = app();
    await topUp(a, 500);
    const { answer } = (await ask(a, { question: 'How do AI code completion and assistants affect developer productivity and code understanding?' }).expect(201)).body;
    const reason = (title: RegExp) => answer.excluded.find((e: { title: string }) => title.test(e.title))?.reason;
    expect(reason(/Nam et al/)).toBe('The license doesn’t allow use in anything that is sold (CC BY-NC-SA 4.0).');
    expect(reason(/Sarkar et al/)).toBe('The license doesn’t allow answering questions with AI (CC BY-NC-ND 4.0).');
    // No license at all: not even a candidate (and certainly never read).
    expect(reason(/Peng et al/)).toBeUndefined();
    expect(JSON.stringify(answer)).not.toMatch(/Peng et al/);
    // CC BY papers may be used, and cost nothing per citation.
    expect(answer.excluded.some((e: { title: string }) => /Ziegler et al|Dohmke/.test(e.title))).toBe(false);
    for (const p of answer.paid.filter((x: { title: string }) => /Ziegler et al|Dohmke/.test(x.title))) expect(p.amountCents).toBe(0);
  });

  it('never lets concurrent answers spend more than the balance', async () => {
    // A slow model, so every answer holds its worst case at the same time.
    const fixture = new FixtureAnswerWriter();
    writer = { name: 'slow', answer: async (input) => (await new Promise((r) => setTimeout(r, 300)), fixture.answer(input)) };
    const a = app();
    // A small balance (below the smallest top-up), so the concurrent answers compete for it.
    const account0 = await db().creditAccount.create({ data: { ownerId: 'user_buyer', balanceCents: 100 } });
    await db().creditEntry.create({ data: { accountId: account0.id, kind: 'top_up', amountCents: 100 } });
    const results = await Promise.all(Array.from({ length: 10 }, () => ask(a, { maxPriceCents: 40 })));
    expect(results.every((r) => r.status === 201 || r.status === 402)).toBe(true);
    expect(results.filter((r) => r.status === 402).length).toBeGreaterThan(0);
    const charged = results.filter((r) => r.status === 201).reduce((n, r) => n + r.body.answer.chargedCents, 0);
    expect(charged).toBeLessThanOrEqual(100);
    const account = await expectLedgerConsistent();
    expect(account.balanceCents).toBe(100 - charged);
  });

  it('pays contributors through PayPal Payouts; failed payouts return to the pool', async () => {
    const a = app();
    await topUp(a);
    await ask(a).expect(201);
    await ask(a, { question: 'Which assistant benefits do developers value most, and why do leaders expand assistant licences?' }).expect(201);
    const summary = (await request(a).get('/api/royalties').set(publisher).expect(200)).body;
    expect(summary.answers).toBe(2);
    expect(summary.accrued.length).toBeGreaterThan(0);
    const owed = summary.accrued.reduce((n: number, c: { amountCents: number }) => n + c.amountCents, 0);

    // Below the minimum, nothing is sent (PayPal fees would eat cents).
    process.env.ROYALTY_PAYOUT_MIN_CENTS = '100000';
    await request(a).post('/api/royalties/payouts').set(publisher).expect(409);
    process.env.ROYALTY_PAYOUT_MIN_CENTS = '1';
    process.env.CREDIT_CLEARING_DAYS = '0'; // pay at once (the clearing period is tested separately)
    const { payout } = (await request(a).post('/api/royalties/payouts').set(publisher).expect(201)).body;
    expect(payout.totalCents).toBe(owed);
    expect(await db().citationCredit.count({ where: { status: 'accrued' } })).toBe(0);
    // Nothing left to pay: a second click can't pay twice.
    await request(a).post('/api/royalties/payouts').set(publisher).expect(409);

    // One contributor's payout fails at PayPal, the rest succeed.
    const [first, ...rest] = payout.items;
    const sender = await db().royaltyPayoutItem.findUniqueOrThrow({ where: { id: first.id } });
    paypal.setAllItems(payout.paypalBatchId, 'SUCCESS');
    paypal.setItemStatus(payout.paypalBatchId, sender.senderItemId, 'FAILED');
    await request(a).post(`/api/royalties/payouts/${payout.id}/refresh`).set(publisher).expect(200);
    expect(await db().citationCredit.count({ where: { status: 'accrued', contributorId: first.contributorId } })).toBeGreaterThan(0);
    for (const item of rest) expect(await db().citationCredit.count({ where: { contributorId: item.contributorId, status: { not: 'paid' } } })).toBe(0);

    // Other publishers can't touch this library's payouts.
    await request(a).post(`/api/royalties/payouts/${payout.id}/refresh`).set({ 'X-Demo-User': 'user_buyer' }).expect(403);
    delete process.env.ROYALTY_PAYOUT_MIN_CENTS;
    delete process.env.CREDIT_CLEARING_DAYS;
  });

  it('takes the credit back when a top-up is refunded in PayPal', async () => {
    const a = app();
    const t = await topUp(a, 500);
    const refund = { id: 'REFUND-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' }, links: [{ rel: 'up', href: `https://x/v2/payments/captures/${t.captureId}` }] };
    const res = await handlePayPalWebhook(db(), paypal, {
      webhookId: 'WH-ID',
      headers: { authAlgo: 'SHA256withRSA', certUrl: 'https://cert', transmissionId: 'WH-R1', transmissionSig: 'valid-signature', transmissionTime: 'now' },
      rawBody: JSON.stringify({ id: 'WH-R1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refund, create_time: '2026-10-22T00:00:00Z' }),
    });
    expect(res).toMatchObject({ status: 'processed' });
    const account = await expectLedgerConsistent();
    expect(account.balanceCents).toBe(0);
    await ask(a).expect(402);
  });

  it('releases the credit held by an answer interrupted by a restart', async () => {
    const a = app();
    await topUp(a);
    const account = await db().creditAccount.findUniqueOrThrow({ where: { ownerId: 'user_buyer' } });
    await db().creditAccount.update({ where: { id: account.id }, data: { reservedCents: 30 } });
    await db().answer.create({ data: { accountId: account.id, libraryId: 'user_atlas', question: QUESTION, maxPriceCents: 30, reservedCents: 30, createdAt: new Date(Date.now() - 3_600_000) } });
    expect(await releaseStaleAnswers(db(), null, new Date(Date.now() - 600_000))).toBe(1);
    await expectLedgerConsistent();
  });

  it('gives the demo buyer starting credit on reset, labeled in the ledger', async () => {
    await softResetDemo(db());
    const account = await expectLedgerConsistent();
    expect(account.balanceCents).toBe(DEMO_CREDIT_CENTS);
    expect(await db().creditEntry.count({ where: { accountId: account.id, kind: 'demo_credit' } })).toBe(1);
    const libs = (await request(app()).get('/api/libraries').set(buyer).expect(200)).body.libraries;
    expect(libs[0]).toMatchObject({ id: 'user_atlas' });
  });

  it('works for an AI agent over the API: top up, ask (402 until paid), read the signed receipt', async () => {
    const a = app();
    const key = { Authorization: `Bearer ${(await createApiKey(db(), 'user_buyer', 'agent')).key}` };
    const libs = (await request(a).get('/api/v1/libraries').set(key).expect(200)).body;
    expect(libs.data[0]).toMatchObject({ id: 'user_atlas', object: 'library' });

    const broke = await request(a).post('/api/v1/answers').set(key).send({ library_id: 'user_atlas', question: QUESTION, max_price_cents: 30 }).expect(402);
    expect(broke.body.error.code).toBe('insufficient_credit');

    const t = (await request(a).post('/api/v1/credit_top_ups').set(key).send({ amount_cents: 500 }).expect(201)).body;
    expect(t.approve_url).toContain(t.paypal_order_id);
    await request(a).post(`/api/v1/credit_top_ups/${t.id}/capture`).set(key).send({}).expect(409); // not approved yet
    paypal.approve(t.paypal_order_id);
    expect((await request(a).post(`/api/v1/credit_top_ups/${t.id}/capture`).set(key).send({}).expect(200)).body.status).toBe('captured');

    const answer = (await request(a).post('/api/v1/answers').set(key).send({ library_id: 'user_atlas', question: QUESTION, max_price_cents: 30 }).expect(201)).body;
    expect(answer).toMatchObject({ object: 'answer', status: 'answered' });
    expect(answer.charged_cents).toBeLessThanOrEqual(30);
    expect((await request(a).get(`/api/v1/answers/${answer.id}`).set(key).expect(200)).body.receipt.signature).toBe(answer.receipt.signature);
    expect((await request(a).get('/api/v1/credits').set(key).expect(200)).body.balance_cents).toBe(500 - answer.charged_cents);
    // A publisher key can't spend a buyer's credit.
    const publisherKey = { Authorization: `Bearer ${(await createApiKey(db(), 'user_atlas', 'pub')).key}` };
    await request(a).post('/api/v1/answers').set(publisherKey).send({ library_id: 'user_atlas', question: QUESTION, max_price_cents: 30 }).expect(403);
  });
});
