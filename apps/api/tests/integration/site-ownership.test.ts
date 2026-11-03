import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { checkSite, claimSite, type FetchText } from '../../src/modules/licenses/ownership';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

const OKAFOR = { 'X-Demo-User': 'user_okafor' };
const ASSET = 'asset_okafor_notes';
const page = (status: number, body: string, url = 'https://okafor.example/.well-known/tracepay-verification.txt'): FetchText => async () => ({ status, body, url, error: null });

describe.runIf(process.env.TEST_DATABASE_URL)('proving control of a source’s website', () => {
  const paypal = new FakePayPal();
  const app = testApp(paypal);
  beforeEach(async () => {
    await resetAndSeed(db());
  });

  it('issues a token for the contributor’s own source only, and keeps it for the same site', async () => {
    const res = await request(app).post(`/api/contributor/assets/${ASSET}/ownership`).set(OKAFOR).send({ site: 'https://okafor.example/notes' }).expect(200);
    expect(res.body.ownership).toMatchObject({ domain: 'okafor.example', verificationUrl: 'https://okafor.example/.well-known/tracepay-verification.txt', verifiedAt: null });
    expect(res.body.ownership.token).toMatch(/^tracepay-verification=[\w-]{24}$/);
    const again = await request(app).post(`/api/contributor/assets/${ASSET}/ownership`).set(OKAFOR).send({ site: 'okafor.example' }).expect(200);
    expect(again.body.ownership.token).toBe(res.body.ownership.token);
    // Someone else's source, or a site that isn't public: refused.
    await request(app).post('/api/contributor/assets/asset_northwind_index/ownership').set(OKAFOR).send({ site: 'okafor.example' }).expect(400);
    await request(app).post(`/api/contributor/assets/${ASSET}/ownership`).set(OKAFOR).send({ site: 'localhost' }).expect(400);
    await request(app).post(`/api/contributor/assets/${ASSET}/ownership`).set({ 'X-Demo-User': 'user_atlas' }).send({ site: 'okafor.example' }).expect(403);
  });

  it('verifies only when the token is on its own line at the site itself', async () => {
    const claim = await claimSite(db(), { assetId: ASSET, contributorId: 'user_okafor', site: 'okafor.example' });
    const check = (f: FetchText) => checkSite(db(), { assetId: ASSET, contributorId: 'user_okafor' }, f);
    expect((await check(page(404, ''))).verifiedAt).toBeNull();
    expect((await check(page(200, `prefix ${claim.token}`))).lastResult).toMatch(/on a line of its own/);
    // A redirect to another site proves nothing about this one.
    expect((await check(page(200, claim.token, 'https://elsewhere.example/.well-known/tracepay-verification.txt'))).lastResult).toMatch(/redirected to another site/);
    const ok = await check(page(200, `# TracePay\n${claim.token}\n`, 'https://www.okafor.example/.well-known/tracepay-verification.txt'));
    expect(ok.verifiedAt).not.toBeNull();
    expect(await db().auditEvent.count({ where: { eventType: 'source.owner_verified', entityId: ASSET } })).toBe(1);
    // A later failed check doesn't undo the proof; claiming another site starts over.
    expect((await check(page(500, ''))).verifiedAt).not.toBeNull();
    expect((await claimSite(db(), { assetId: ASSET, contributorId: 'user_okafor', site: 'other.example' })).verifiedAt).toBeNull();
  });

  it('shows publishers the verified site (never the token), and signs it into answer receipts', async () => {
    const claim = await claimSite(db(), { assetId: 'asset_northwind_index', contributorId: 'user_northwind', site: 'northwind.example' });
    await checkSite(db(), { assetId: 'asset_northwind_index', contributorId: 'user_northwind' }, page(200, claim.token, 'https://northwind.example/.well-known/tracepay-verification.txt'));

    const market = (await request(app).get('/api/marketplace').set({ 'X-Demo-User': 'user_atlas' }).expect(200)).body;
    expect(market.sources.find((s: { assetId: string }) => s.assetId === 'asset_northwind_index').ownerVerifiedSite).toBe('northwind.example');
    expect(JSON.stringify(market)).not.toContain(claim.token);

    const buyer = { 'X-Demo-User': 'user_buyer' };
    const started = await request(app).post('/api/credits/top-ups').set(buyer).send({ amountCents: 500 }).expect(201);
    paypal.approve(started.body.orderId);
    await request(app).post(`/api/credits/top-ups/${started.body.topUpId}/capture`).set(buyer).expect(200);
    const { answer } = (await request(app).post('/api/answers').set(buyer).send({ libraryId: 'user_atlas', question: 'How fast is spending on AI coding assistants growing, and how many developers use an assistant weekly?', maxPriceCents: 50 }).expect(201)).body;
    const northwind = answer.paid.find((p: { title: string }) => p.title === 'Northwind DevTools Spend Index 2026');
    expect(northwind).toMatchObject({ ownerVerified: 'northwind.example' });
    const signed = answer.receipt.document.paid.find((p: { assetVersionId: string }) => p.assetVersionId === northwind.assetVersionId);
    expect(signed.ownerVerified).toBe('northwind.example');
    for (const p of answer.paid.filter((x: { title: string }) => x.title !== northwind.title)) expect(p.ownerVerified).toBeNull();
  });
});
