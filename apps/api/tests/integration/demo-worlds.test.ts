import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

/** Each visitor of a hosted demo gets a private copy of it: nobody sees or resets anyone else's. */
describe.runIf(process.env.TEST_DATABASE_URL)('private demo worlds', () => {
  const app = testApp(new FakePayPal());
  const intent = { title: 'Developer Tools Market Brief, Q4 2026', brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.', purpose: 'commercial_report', distribution: 'sale', includesRawData: false, territory: 'US', priceCents: 2000, currency: 'USD' };

  beforeEach(async () => {
    await resetAndSeed(db());
  });

  async function newWorld() {
    const res = await request(app).post('/api/demo/worlds').expect(201);
    const token: string = res.body.token;
    const as = (base: string) => ({ 'X-Demo-World': token, 'X-Demo-User': res.body.users.find((u: { id: string }) => u.id.endsWith(`_${base}`)).id });
    return { token, publisherId: res.body.publisherId as string, users: res.body.users as Array<{ id: string; role: string }>, as };
  }

  async function listReport(headers: Record<string, string>, ids: string[]) {
    const pre = await request(app).post('/api/builds/preflight').set(headers).send({ intent, assetVersionIds: ids }).expect(201);
    return (await request(app).post(`/api/builds/${pre.body.buildId}/generate`).set(headers).expect(201)).body.artifactId as string;
  }

  it('gives a visitor their own publisher, buyer, contributors and licensed sources', async () => {
    const w = await newWorld();
    expect(w.users.map((u) => u.role).sort()).toEqual(['buyer', 'contributor', 'contributor', 'contributor', 'contributor', 'contributor', 'publisher']);
    const me = await request(app).get('/api/me').set(w.as('user_atlas')).expect(200);
    expect(me.body.user).toMatchObject({ id: w.publisherId, name: 'Atlas Research Studio', role: 'publisher' });
    const catalog = (await request(app).get('/api/catalog').set(w.as('user_atlas')).expect(200)).body.assets;
    expect(catalog.length).toBe(5);
    expect(catalog.every((a: { assetVersionId: string }) => a.assetVersionId.startsWith(w.publisherId.slice(0, 16)))).toBe(true);
    const users = (await request(app).get('/api/demo/users').set({ 'X-Demo-World': w.token }).expect(200)).body.users;
    expect(users.map((u: { id: string }) => u.id)).toEqual(w.users.map((u) => u.id).sort((a, b) => w.users.findIndex((u) => u.id === a) - w.users.findIndex((u) => u.id === b)));
  });

  it('opens a world only with its secret', async () => {
    const w = await newWorld();
    const id = w.as('user_atlas')['X-Demo-User'];
    await request(app).get('/api/me').set({ 'X-Demo-User': id }).expect(401);
    await request(app).get('/api/me').set({ 'X-Demo-User': id, 'X-Demo-World': `${w.token.split('.')[0]}.wrong-secret-wrong-secret` }).expect(401);
    const other = await newWorld();
    await request(app).get('/api/me').set({ 'X-Demo-User': id, 'X-Demo-World': other.token }).expect(401);
  });

  it('keeps every world’s store, libraries and marketplace to itself', async () => {
    const a = await newWorld();
    const b = await newWorld();
    const sourcesOf = (w: Awaited<ReturnType<typeof newWorld>>) => ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'].map((s) => `${w.publisherId.slice(0, 16)}${s}`);
    const reportA = await listReport(a.as('user_atlas'), sourcesOf(a));

    const store = async (h: Record<string, string>) => (await request(app).get('/api/artifacts').set(h).expect(200)).body.artifacts.map((x: { id: string }) => x.id);
    expect(await store(a.as('user_buyer'))).toEqual([reportA]);
    expect(await store(b.as('user_buyer'))).toEqual([]);
    expect(await store({ 'X-Demo-User': 'user_buyer' })).toEqual([]); // the shared demo
    expect(await store({})).toEqual([]);

    const libs = async (h: Record<string, string>) => (await request(app).get('/api/libraries').set(h).expect(200)).body.libraries.map((l: { id: string }) => l.id);
    expect(await libs(a.as('user_buyer'))).toEqual([a.publisherId]);
    expect(await libs({ 'X-Demo-User': 'user_buyer' })).toEqual(['user_atlas']);
    await request(app).post('/api/answers').set(b.as('user_buyer')).send({ libraryId: a.publisherId, question: 'How fast is spending on AI coding assistants growing?', maxPriceCents: 50 }).expect(404);

    const market = (await request(app).get('/api/marketplace').set(b.as('user_atlas')).expect(200)).body;
    const owners = JSON.stringify(market);
    expect(owners).not.toMatch(new RegExp(a.publisherId.slice(0, 16)));
    expect(owners).not.toMatch(/"user_northwind"/);
  });

  it('resets only the visitor’s own world', async () => {
    const a = await newWorld();
    const b = await newWorld();
    const ids = (w: Awaited<ReturnType<typeof newWorld>>) => ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'].map((s) => `${w.publisherId.slice(0, 16)}${s}`);
    await listReport(a.as('user_atlas'), ids(a));
    const reportB = await listReport(b.as('user_atlas'), ids(b));
    const shared = await listReport({ 'X-Demo-User': 'user_atlas' }, ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1']);

    const reset = await request(app).post('/api/demo/reset').set(a.as('user_atlas')).expect(200);
    expect(reset.body.removedBuilds).toBe(1);
    expect(await db().artifact.count({ where: { buildJob: { publisherId: a.publisherId } } })).toBe(0);
    expect(await db().artifact.findUnique({ where: { id: reportB } })).not.toBeNull();
    expect(await db().artifact.findUnique({ where: { id: shared } })).not.toBeNull();
  });
});
