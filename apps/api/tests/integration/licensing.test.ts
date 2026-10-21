import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LicenseTerms } from '@tracepay/shared';
import { db } from '../../src/db';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

const CONTENT = [
  'Harbor Analytics Cloud Spend Tracker, autumn 2026 edition. Figures are fictional demo data.',
  'Mid-market software companies increased cloud infrastructure spend by 19% year over year in Q3 2026, led by GPU capacity for AI features.',
  'Teams adopting AI coding assistants reported 31% more deployments per week, which pushed observability and CI costs up in parallel.',
  'Committed-use discounts now cover 44% of tracked compute spend, up from 29% a year earlier.',
].join('\n\n');

const LICENSE_TEXT =
  'Licensee may use the Tracker to create and sell derivative research reports worldwide until 30 June 2028. ' +
  'Raw tracker data may not be redistributed. Licensor receives 20% of the gross sale price of each report that uses the Tracker.';

const intent = {
  title: 'Cloud and Developer Tools Brief',
  brief: 'Cloud spend, AI coding assistant adoption, deployments, observability and CI costs.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includesRawData: false,
  territory: 'US',
  priceCents: 2000,
  currency: 'USD',
};

describe.runIf(process.env.TEST_DATABASE_URL)('contributor onboarding and license lifecycle (integration)', () => {
  const paypal = new FakePayPal();
  const app = testApp(paypal, { demoMode: false });
  const contributor = request.agent(app);
  const publisher = request.agent(app);
  const otherPublisher = request.agent(app);
  let assetId: string;
  let assetVersionId: string;
  let terms: LicenseTerms;

  beforeAll(async () => {
    await resetAndSeed(db());
    await contributor.post('/api/auth/signup').send({ email: 'harbor@data.example', password: 'harbor data pass', name: 'Harbor Analytics', role: 'contributor', paypalEmail: 'payouts@harbor.example' }).expect(201);
    await publisher.post('/api/auth/signup').send({ email: 'desk@studio.example', password: 'studio desk pass', name: 'Signal Studio', role: 'publisher' }).expect(201);
    await otherPublisher.post('/api/auth/signup').send({ email: 'other@studio.example', password: 'other studio pass', name: 'Other Studio', role: 'publisher' }).expect(201);
  });

  it('lets a contributor register a source with a fingerprinted first version', async () => {
    await contributor.post('/api/contributor/assets').send({ title: 'x', kind: 'dataset', description: 'too short content', content: 'tiny' }).expect(400);
    const res = await contributor
      .post('/api/contributor/assets')
      .send({ title: 'Harbor Cloud Spend Tracker', kind: 'dataset', description: 'Quarterly cloud spend across mid-market software companies.', content: CONTENT })
      .expect(201);
    assetId = res.body.assetId;
    assetVersionId = res.body.assetVersionId;
    expect(res.body.chunks).toBe(4);
    await contributor.post(`/api/contributor/assets/${assetId}/versions`).send({ content: CONTENT }).expect(409); // unchanged
  });

  it('lists the source in the marketplace without exposing its content', async () => {
    const res = await publisher.get('/api/marketplace').expect(200);
    const listing = res.body.sources.find((s: { assetId: string }) => s.assetId === assetId);
    expect(listing).toMatchObject({ title: 'Harbor Cloud Spend Tracker', owner: { name: 'Harbor Analytics' }, passages: 4, myLicense: null });
    expect(JSON.stringify(res.body)).not.toContain('Committed-use discounts');
  });

  it('drafts terms from a license document with quoted evidence (never saved)', async () => {
    const res = await contributor.post('/api/licenses/extract').send({ text: LICENSE_TEXT }).expect(200);
    expect(res.body.source).toBe('rules');
    expect(res.body.terms).toMatchObject({
      commercialUse: true,
      rawRedistribution: false,
      economics: { kind: 'percent_of_gross', bps: 2000 },
      validUntil: '2028-06-30',
      territories: null,
    });
    expect(res.body.evidence.find((e: { field: string }) => e.field === 'economics').quote).toContain('20%');
    terms = res.body.terms;
    expect(await db().licenseGrant.count({ where: { assetId } })).toBe(0);
  });

  it('turns a publisher request into an offer, and only activates it on acceptance', async () => {
    const reqRes = await publisher.post(`/api/marketplace/${assetId}/request`).send({ message: 'We would like to cite this in a paid brief.' }).expect(201);
    expect(reqRes.body.license.status).toBe('requested');
    await publisher.post(`/api/marketplace/${assetId}/request`).send({}).expect(409); // already requested

    // Not yet licensed: the compiler blocks it.
    const blocked = await publisher.post('/api/builds/preflight').send({ intent, assetVersionIds: [assetVersionId] }).expect(201);
    expect(blocked.body.report.verdict).toBe('block');

    const offer = await contributor
      .post(`/api/contributor/assets/${assetId}/offers`)
      .send({ licenseeEmail: 'desk@studio.example', terms, origin: 'rules_draft', sourceText: LICENSE_TEXT })
      .expect(201);
    expect(offer.body.license).toMatchObject({ id: reqRes.body.license.id, status: 'offered' }); // fulfils the request

    const stillBlocked = await publisher.post('/api/builds/preflight').send({ intent, assetVersionIds: [assetVersionId] }).expect(201);
    expect(stillBlocked.body.report.verdict).toBe('block'); // an offer is not a license

    const inbox = await publisher.get('/api/licenses/inbox').expect(200);
    const pending = inbox.body.licenses[0];
    expect(pending).toMatchObject({ status: 'offered', asset: { title: 'Harbor Cloud Spend Tracker' }, current: null });

    // Accepting requires the exact terms that were reviewed.
    await publisher.post(`/api/licenses/${pending.id}/accept`).send({ termsHash: '0'.repeat(64) }).expect(409);
    await otherPublisher.post(`/api/licenses/${pending.id}/accept`).send({ termsHash: pending.termsHash }).expect(404);
    await publisher.post(`/api/licenses/${pending.id}/accept`).send({ termsHash: pending.termsHash }).expect(200);

    const passed = await publisher.post('/api/builds/preflight').send({ intent, assetVersionIds: [assetVersionId] }).expect(201);
    expect(passed.body.report.verdict).toBe('pass');
  });

  it('keeps the active license in force while a renegotiation is pending, then supersedes it', async () => {
    const raised = { ...terms, economics: { kind: 'percent_of_gross' as const, bps: 3000 } };
    const offer = await contributor.post(`/api/contributor/assets/${assetId}/offers`).send({ licenseeEmail: 'desk@studio.example', terms: raised }).expect(201);

    const during = await publisher.get('/api/catalog').expect(200);
    const entry = during.body.assets.find((a: { assetId: string }) => a.assetId === assetId);
    expect(entry.license.terms.economics.bps).toBe(2000); // old terms still govern
    expect(entry.pending).toMatchObject({ status: 'offered' });

    const inbox = await publisher.get('/api/licenses/inbox').expect(200);
    expect(inbox.body.licenses[0].current.terms.economics.bps).toBe(2000); // shown side by side

    await publisher.post(`/api/licenses/${offer.body.license.id}/accept`).send({ termsHash: offer.body.license.termsHash }).expect(200);
    const after = (await publisher.get('/api/catalog').expect(200)).body.assets.find((a: { assetId: string }) => a.assetId === assetId);
    expect(after.license.terms.economics.bps).toBe(3000);
    expect(await db().licenseGrant.count({ where: { assetId, status: 'superseded' } })).toBe(1);
  });

  it('shows the license in force, not a newer offer, in the marketplace', async () => {
    const listing = async () => (await publisher.get('/api/marketplace').expect(200)).body.sources.find((s: { assetId: string }) => s.assetId === assetId);
    const newer = await contributor.post(`/api/contributor/assets/${assetId}/offers`).send({ licenseeEmail: 'desk@studio.example', terms }).expect(201);
    expect(await listing()).toMatchObject({ myLicense: { status: 'approved' }, pendingLicense: { id: newer.body.license.id, status: 'offered' } });

    // Declining the newer terms doesn't end the license already in force.
    await publisher.post(`/api/licenses/${newer.body.license.id}/decline`).send({}).expect(200);
    expect(await listing()).toMatchObject({ myLicense: { status: 'approved' }, pendingLicense: null });
  });

  it('lets the publisher decline and the contributor withdraw offers', async () => {
    const o1 = await contributor.post(`/api/contributor/assets/${assetId}/offers`).send({ licenseeEmail: 'other@studio.example', terms }).expect(201);
    await otherPublisher.post(`/api/licenses/${o1.body.license.id}/decline`).send({ reason: 'Too expensive' }).expect(200);
    const o2 = await contributor.post(`/api/contributor/assets/${assetId}/offers`).send({ licenseeEmail: 'other@studio.example', terms }).expect(201);
    await contributor.post(`/api/licenses/${o2.body.license.id}/withdraw`).send({}).expect(200);
    await otherPublisher.post(`/api/licenses/${o2.body.license.id}/accept`).send({ termsHash: o2.body.license.termsHash }).expect(409);
  });

  it('revocation stops new builds AND further sales, but never rewrites a completed sale', async () => {
    // Build a report and sell one copy while licensed (30% after the renegotiation).
    const build = await publisher.post('/api/builds/preflight').send({ intent, assetVersionIds: [assetVersionId] }).expect(201);
    const artifactId = (await publisher.post(`/api/builds/${build.body.buildId}/generate`).expect(201)).body.artifactId;
    const buyer = request.agent(app);
    await buyer.post('/api/auth/signup').send({ email: 'reader@buyer.example', password: 'reader buyer pass', name: 'Reader', role: 'buyer' }).expect(201);
    const order = await buyer.post('/api/checkout/orders').send({ artifactId }).expect(201);
    paypal.approve(order.body.orderId);
    const cap = await buyer.post(`/api/checkout/${order.body.saleId}/capture`).expect(200);

    const grant = await db().licenseGrant.findFirstOrThrow({ where: { assetId, status: 'approved' } });
    await publisher.post(`/api/licenses/${grant.id}/revoke`).send({}).expect(403); // only the licensor revokes
    await contributor.post(`/api/licenses/${grant.id}/revoke`).send({ reason: 'Contract ended' }).expect(200);

    // New builds are blocked…
    const after = await publisher.post('/api/builds/preflight').send({ intent, assetVersionIds: [assetVersionId] }).expect(201);
    expect(after.body.report.results.find((r: { ruleId: string }) => r.ruleId === 'LICENSE_APPROVED').outcome).toBe('fail');
    // …the report is taken off sale immediately, and can't be relisted…
    expect((await db().artifact.findUniqueOrThrow({ where: { id: artifactId } })).status).toBe('withdrawn');
    const second = request.agent(app);
    await second.post('/api/auth/signup').send({ email: 'late@buyer.example', password: 'late buyer pass', name: 'Late', role: 'buyer' }).expect(201);
    await second.post('/api/checkout/orders').send({ artifactId }).expect(409);
    const relist = await publisher.post(`/api/artifacts/${artifactId}/relist`).expect(409);
    expect(relist.body.error).toMatch(/can't be sold yet/);
    // …while the sale completed before revocation still settles at the agreed 30%.
    const line = await db().settlementLine.findFirstOrThrow({ where: { runId: cap.body.settlementRunId, kind: 'contributor' } });
    expect(line.amountCents).toBe(600);
    expect(await db().auditEvent.count({ where: { eventType: 'artifact.withdrawn', entityId: artifactId } })).toBe(1);
  });

  it('keeps contributors in their own lane', async () => {
    const other = request.agent(app);
    await other.post('/api/auth/signup').send({ email: 'rival@data.example', password: 'rival data pass', name: 'Rival Data', role: 'contributor' }).expect(201);
    expect((await other.get('/api/contributor/assets').expect(200)).body.assets).toEqual([]);
    await other.post(`/api/contributor/assets/${assetId}/versions`).send({ content: `${CONTENT}\n\nAppended by someone else, which must never be allowed to happen.` }).expect(404);
    await other.post(`/api/contributor/assets/${assetId}/offers`).send({ licenseeEmail: 'desk@studio.example', terms }).expect(404);
    // Buyers can't be licensees — and the answer is identical to "no such account" (no enumeration).
    const asBuyer = await contributor.post(`/api/contributor/assets/${assetId}/offers`).send({ licenseeEmail: 'reader@buyer.example', terms }).expect(404);
    const unknown = await contributor.post(`/api/contributor/assets/${assetId}/offers`).send({ licenseeEmail: 'nobody@nowhere.example', terms }).expect(404);
    expect(asBuyer.body.error).toBe(unknown.body.error);
  });

  it('records the whole lifecycle in the publisher’s audit trail', async () => {
    const events = await db().auditEvent.findMany({ where: { entityType: 'license' }, select: { eventType: true } });
    const types = new Set(events.map((e) => e.eventType));
    for (const t of ['license.requested', 'license.offered', 'license.accepted', 'license.declined', 'license.withdrawn', 'license.revoked']) expect(types.has(t)).toBe(true);
  });
});
