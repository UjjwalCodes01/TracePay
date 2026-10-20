import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { createApiKey, signUp } from '../../src/modules/auth/auth.service';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { openApiDocument } from '../../src/platform-api';
import { routes } from '../../src/platform-api/framework';
import { FakePayPal } from '../fake-paypal';
import { TEST_ORIGIN, testApp } from '../test-app';

const intent = {
  title: 'Developer Tools Market Brief, Q4 2026',
  brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includes_raw_data: false,
  territory: 'us',
  price_cents: 2000,
  currency: 'USD',
};
const PASSING = ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'];
const BLOCKED = ['asset_northwind_index_v1', 'asset_kestrel_panel_v1'];
const buyer = { 'X-Demo-User': 'user_buyer' };

describe.runIf(process.env.TEST_DATABASE_URL)('platform API /api/v1 (integration)', () => {
  const paypal = new FakePayPal();
  const app = testApp(paypal);
  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

  let atlasKey: string;
  let readOnlyKey: string;
  let otherKey: string;
  let atlas: Record<string, string>;
  let reportId: string;
  let saleId: string;
  let settlementId: string;

  beforeAll(async () => {
    await resetAndSeed(db());
    atlasKey = (await createApiKey(db(), 'user_atlas', 'integration')).key;
    readOnlyKey = (await createApiKey(db(), 'user_atlas', 'reporting', { access: 'read_only' })).key;
    const other = await signUp(db(), { email: 'other@publisher.example', password: 'a long enough password', name: 'Other Publisher', role: 'publisher' });
    otherKey = (await createApiKey(db(), other.id, 'theirs')).key;
    atlas = bearer(atlasKey);
  });

  describe('authentication and access', () => {
    it('requires credentials, with the documented error shape and a request id', async () => {
      const res = await request(app).get('/api/v1/account').expect(401);
      expect(res.body).toEqual({ error: { type: 'authentication_error', code: 'unauthenticated', message: expect.any(String) }, request_id: res.headers['x-request-id'] });
    });

    it('rejects unknown, revoked and expired keys', async () => {
      expect((await request(app).get('/api/v1/account').set(bearer('tp_nope')).expect(401)).body.error.code).toBe('invalid_api_key');
      const revoked = await createApiKey(db(), 'user_atlas', 'old');
      await db().apiKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
      await request(app).get('/api/v1/account').set(bearer(revoked.key)).expect(401);
      const expired = await createApiKey(db(), 'user_atlas', 'temp', { expiresInDays: 1 });
      await request(app).get('/api/v1/account').set(bearer(expired.key)).expect(200);
      await db().apiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await request(app).get('/api/v1/account').set(bearer(expired.key)).expect(401);
    });

    it('describes the account and key', async () => {
      const res = await request(app).get('/api/v1/account').set(atlas).expect(200);
      expect(res.body).toMatchObject({ id: 'user_atlas', object: 'account', role: 'publisher', authenticated_with: 'api_key', api_key: { access: 'read_write' } });
    });

    it('limits read-only keys to GET', async () => {
      await request(app).get('/api/v1/builds').set(bearer(readOnlyKey)).expect(200);
      const res = await request(app).post('/api/v1/builds').set(bearer(readOnlyKey)).send({ intent, source_version_ids: PASSING }).expect(403);
      expect(res.body.error).toMatchObject({ type: 'permission_error', code: 'read_only_key' });
      expect(await db().buildJob.count({ where: { intent: { path: ['title'], equals: 'never' } } })).toBe(0);
    });

    it('demo visitors get short-lived keys, revoked by “Reset demo”', async () => {
      const res = await request(app).post('/api/auth/api-keys').set({ 'X-Demo-User': 'user_atlas', Origin: TEST_ORIGIN }).send({ name: 'Judge', expiresInDays: 365 }).expect(201);
      expect(new Date(res.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000 + 5_000);
    });

    it('limits publisher-only actions to publishers, as the dashboard does', async () => {
      const adminKey = (await createApiKey(db(), 'user_admin', 'ops')).key;
      const res = await request(app).post('/api/v1/builds').set(bearer(adminKey)).send({ intent, source_version_ids: PASSING }).expect(403);
      expect(res.body.error.code).toBe('forbidden');
      await request(app).get('/api/v1/builds').set(bearer(adminKey)).expect(200);
    });

    it('is for publisher accounts only', async () => {
      const contributorKey = (await createApiKey(db(), 'user_northwind', 'c')).key;
      expect((await request(app).get('/api/v1/sources').set(bearer(contributorKey)).expect(403)).body.error.code).toBe('publisher_account_required');
    });

    it('accepts a signed-in session, with the CSRF origin check on writes', async () => {
      await request(app).get('/api/v1/account').set({ 'X-Demo-User': 'user_atlas' }).expect(200);
      await request(app).post('/api/v1/builds').set({ 'X-Demo-User': 'user_atlas', Origin: 'https://evil.example' }).send({ intent, source_version_ids: PASSING }).expect(403);
    });

    it('manages keys from the dashboard: access level, expiry, a cap, and never via another key', async () => {
      const created = await request(app)
        .post('/api/auth/api-keys')
        .set({ 'X-Demo-User': 'user_atlas', Origin: TEST_ORIGIN })
        .send({ name: 'Reporting', access: 'read_only', expiresInDays: 30 })
        .expect(201);
      expect(created.body).toMatchObject({ access: 'read_only', key: expect.stringMatching(/^tp_/) });
      // A demo visitor asked for 30 days and got at most one.
      expect(new Date(created.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000 + 5_000);
      // Keys never manage keys (they aren't accepted outside /api/v1 at all).
      await request(app).post('/api/auth/api-keys').set(atlas).send({ name: 'x' }).expect(401);
      await request(app).post('/api/auth/api-keys').set({ 'X-Demo-User': 'user_atlas', Origin: TEST_ORIGIN }).send({ name: 'x', expiresInDays: 0 }).expect(400);
    });
  });

  describe('the publisher workflow end to end', () => {
    it('lists sources with license status', async () => {
      const res = await request(app).get('/api/v1/sources').set(atlas).expect(200);
      expect(res.body.object).toBe('list');
      const northwind = res.body.data.find((s: { id: string }) => s.id === 'asset_northwind_index');
      expect(northwind).toMatchObject({ object: 'source', version: { id: 'asset_northwind_index_v1' }, license: { status: 'approved', terms: { commercial_use: true } } });
      await request(app).get('/api/v1/sources/asset_northwind_index').set(atlas).expect(200);
      await request(app).get('/api/v1/sources/nope').set(atlas).expect(404);
    });

    it('records a blocked build with the rule that blocked it, and refuses to generate it', async () => {
      const res = await request(app).post('/api/v1/builds').set(atlas).send({ intent, source_version_ids: BLOCKED }).expect(201);
      expect(res.body).toMatchObject({ object: 'build', status: 'preflight_blocked', preflight: { verdict: 'block' }, intent: { territory: 'US' } });
      expect(res.body.preflight.rules.some((r: { outcome: string }) => r.outcome === 'fail')).toBe(true);
      const gen = await request(app).post(`/api/v1/builds/${res.body.id}/generate`).set(atlas).expect(409);
      expect(gen.body.error.type).toBe('conflict_error');
    });

    it('builds, generates and lists a report', async () => {
      const build = await request(app).post('/api/v1/builds').set(atlas).send({ intent, source_version_ids: PASSING }).expect(201);
      expect(build.body).toMatchObject({ status: 'preflight_passed', preflight: { verdict: 'pass' }, sources: [{ position: 0 }, { position: 1 }, { position: 2 }] });
      const gen = await request(app).post(`/api/v1/builds/${build.body.id}/generate`).set(atlas).expect(201);
      expect(gen.body).toMatchObject({ object: 'generation', build_id: build.body.id, report: { status: 'listed', content: null } });
      reportId = gen.body.report.id;
      const full = await request(app).get(`/api/v1/reports/${reportId}?include=content`).set(atlas).expect(200);
      expect(full.body.content.sections.length).toBeGreaterThan(0);
      await request(app).get(`/api/v1/builds/${build.body.id}`).set(atlas).expect(200).expect((r) => expect(r.body.report_id).toBe(reportId));
    });

    it('follows the sale, settles it and pays out through PayPal', async () => {
      const order = await request(app).post('/api/checkout/orders').set(buyer).send({ artifactId: reportId }).expect(201);
      paypal.approve(order.body.orderId);
      await request(app).post(`/api/checkout/${order.body.saleId}/capture`).set(buyer).expect(200);
      saleId = order.body.saleId;

      const sales = await request(app).get(`/api/v1/sales?status=captured&report_id=${reportId}`).set(atlas).expect(200);
      expect(sales.body.data).toHaveLength(1);
      expect(sales.body.data[0]).toMatchObject({ id: saleId, status: 'captured', amount_cents: 2000, paypal: { capture_status: 'COMPLETED' } });
      settlementId = sales.body.data[0].settlement_id;

      const s = await request(app).get(`/api/v1/settlements/${settlementId}`).set(atlas).expect(200);
      expect(s.body).toMatchObject({ status: 'calculated', gross_cents: 2000 });
      expect(s.body.lines.reduce((sum: number, l: { amount_cents: number }) => sum + l.amount_cents, 0)).toBe(2000);
      await request(app).post(`/api/v1/settlements/${settlementId}/payouts`).set(atlas).expect(409); // not approved yet
      await request(app).post(`/api/v1/settlements/${settlementId}/approve`).set(atlas).expect(200).expect((r) => expect(r.body.status).toBe('approved'));
      const paid = await request(app).post(`/api/v1/settlements/${settlementId}/payouts`).set(atlas).expect(201);
      expect(paid.body.payout_batches).toHaveLength(1);
      await request(app).post(`/api/v1/settlements/${settlementId}/refresh`).set(atlas).expect(200);
    });

    it('serves the signed receipt and the provenance graph', async () => {
      const receipt = await request(app).get(`/api/v1/reports/${reportId}/receipt`).set(atlas).expect(200);
      expect(receipt.body).toMatchObject({ object: 'receipt', algorithm: 'Ed25519' });
      await request(app).post('/api/receipts/verify').send({ document: receipt.body.document, signature: receipt.body.signature }).expect(200).expect((r) => expect(r.body.valid).toBe(true));
      const prov = await request(app).get(`/api/v1/reports/${reportId}/provenance`).set(atlas).expect(200);
      expect(prov.body.nodes.length).toBeGreaterThan(3);
    });

    it('withdraws and relists a report', async () => {
      const w = await request(app).post(`/api/v1/reports/${reportId}/withdraw`).set(atlas).expect(200);
      expect(w.body).toMatchObject({ status: 'withdrawn', withdrawn_reason: 'Withdrawn by the publisher.' });
      await request(app).post(`/api/v1/reports/${reportId}/relist`).set(atlas).expect(200).expect((r) => expect(r.body.status).toBe('listed'));
    });

    it('records every step in the event log, newest first and filterable', async () => {
      const all = await request(app).get('/api/v1/events?limit=100').set(atlas).expect(200);
      const types = all.body.data.map((e: { type: string }) => e.type);
      for (const t of ['build.preflight_blocked', 'build.preflight_passed', 'report.created', 'sale.created', 'sale.completed', 'settlement.created', 'settlement.approved', 'payout_batch.submitted', 'report.withdrawn', 'report.relisted']) {
        expect(types, t).toContain(t);
      }
      const created = all.body.data.map((e: { created: string }) => e.created);
      expect([...created].sort().reverse()).toEqual(created);
      const sale = await request(app).get(`/api/v1/events?type=sale.completed&object_id=${saleId}`).set(atlas).expect(200);
      expect(sale.body.data).toHaveLength(1);
      expect(sale.body.data[0]).toMatchObject({ object: 'event', api_version: 'v1', sandbox: true, data: { object_type: 'sale', object_id: saleId, report_id: reportId } });
      await request(app).get(`/api/v1/events/${sale.body.data[0].id}`).set(atlas).expect(200);
      await request(app).get('/api/v1/events?type=made.up').set(atlas).expect(400);
      expect((await request(app).get('/api/v1/event_types').set(atlas).expect(200)).body.data.length).toBeGreaterThan(30);
    });

    it('never puts source content or payout addresses in events', async () => {
      const events = await db().outboundEvent.findMany({ where: { ownerId: 'user_atlas' } });
      const payees = (await db().user.findMany({ where: { paypalEmail: { not: null } }, select: { paypalEmail: true } })).map((u) => u.paypalEmail!);
      const blob = JSON.stringify(events);
      for (const email of payees) expect(blob).not.toContain(email);
      expect(blob).not.toContain('"content"');
    });

    it('runs the Publisher Agent', async () => {
      const run = await request(app).post('/api/v1/agent_runs').set(atlas).send({ goal: 'Create a commercial report from approved sources.', intent, source_version_ids: PASSING }).expect(202);
      expect(run.body).toMatchObject({ object: 'agent_run', status: 'running' });
      await request(app).get(`/api/v1/agent_runs/${run.body.id}`).set(atlas).expect(200);
      await request(app).get('/api/v1/agent_runs').set(atlas).expect(200);
    });

    it('requests a license for a source', async () => {
      const marketplace = await request(app).get('/api/v1/sources').set(bearer(otherKey)).expect(200);
      const target = marketplace.body.data.find((s: { license: unknown; pending_license: unknown }) => !s.license && !s.pending_license);
      const lic = await request(app).post(`/api/v1/sources/${target.id}/license_requests`).set(bearer(otherKey)).send({ message: 'For our Q1 brief.' }).expect(201);
      expect(lic.body).toMatchObject({ object: 'license', status: 'requested', request_message: 'For our Q1 brief.', terms: null });
      expect((await request(app).get('/api/v1/licenses?status=requested').set(bearer(otherKey)).expect(200)).body.data).toHaveLength(1);
      await request(app).post(`/api/v1/licenses/${lic.body.id}/accept`).set(bearer(otherKey)).send({ terms_hash: 'a'.repeat(64) }).expect(409);
    });
  });

  describe('tenant isolation', () => {
    it('answers 404 for another publisher’s objects and shows them nothing in lists', async () => {
      const theirs = bearer(otherKey);
      const builds = await request(app).get('/api/v1/builds').set(atlas).expect(200);
      for (const path of [
        `/api/v1/builds/${builds.body.data[0].id}`, `/api/v1/reports/${reportId}`, `/api/v1/reports/${reportId}/receipt`, `/api/v1/reports/${reportId}/provenance`,
        `/api/v1/sales/${saleId}`, `/api/v1/settlements/${settlementId}`,
      ]) {
        expect((await request(app).get(path).set(theirs)).status, path).toBe(404);
      }
      for (const path of [`/api/v1/settlements/${settlementId}/approve`, `/api/v1/reports/${reportId}/withdraw`, `/api/v1/builds/${builds.body.data[0].id}/generate`]) {
        expect((await request(app).post(path).set(theirs)).status, path).toBe(404);
      }
      const event = (await request(app).get('/api/v1/events?limit=1').set(atlas)).body.data[0];
      await request(app).get(`/api/v1/events/${event.id}`).set(theirs).expect(404);
      for (const list of ['builds', 'reports', 'sales', 'settlements', 'agent_runs', 'events']) {
        const res = await request(app).get(`/api/v1/${list}`).set(theirs).expect(200);
        expect(res.body.data.filter((x: { type?: string }) => !x.type?.startsWith('license.')), list).toEqual([]);
      }
    });
  });

  describe('pagination', () => {
    it('pages through every item exactly once', async () => {
      for (let i = 0; i < 5; i++) await request(app).post('/api/v1/builds').set(atlas).send({ intent: { ...intent, title: `Paging ${i}` }, source_version_ids: PASSING }).expect(201);
      const total = await db().buildJob.count({ where: { publisherId: 'user_atlas' } });
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await request(app).get(`/api/v1/builds?limit=2${cursor ? `&starting_after=${cursor}` : ''}`).set(atlas).expect(200);
        seen.push(...res.body.data.map((b: { id: string }) => b.id));
        expect(res.body.has_more).toBe(res.body.next_cursor !== null);
        cursor = res.body.next_cursor;
        pages++;
      } while (cursor && pages < 50);
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    });

    it('validates limit and cursor', async () => {
      for (const q of ['limit=0', 'limit=101', 'limit=abc']) expect((await request(app).get(`/api/v1/builds?${q}`).set(atlas)).status, q).toBe(400);
      const bad = await request(app).get('/api/v1/builds?starting_after=garbage').set(atlas).expect(400);
      expect(bad.body.error).toMatchObject({ code: 'invalid_cursor' });
    });
  });

  describe('idempotency', () => {
    const body = { intent: { ...intent, title: 'Idempotent build' }, source_version_ids: PASSING };

    it('runs once and replays the stored response for the same key and body', async () => {
      const first = await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'build-1' }).send(body).expect(201);
      const again = await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'build-1' }).send(body).expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await db().buildJob.count({ where: { intent: { path: ['title'], equals: 'Idempotent build' } } })).toBe(1);
    });

    it('refuses the same key with a different body', async () => {
      const res = await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'build-1' }).send({ ...body, source_version_ids: BLOCKED }).expect(422);
      expect(res.body.error.code).toBe('idempotency_key_reused');
    });

    it('replays client errors too, but not while the first request is still running', async () => {
      const blocked = (await request(app).post('/api/v1/builds').set(atlas).send({ intent, source_version_ids: BLOCKED }).expect(201)).body.id;
      const a = await request(app).post(`/api/v1/builds/${blocked}/generate`).set({ ...atlas, 'Idempotency-Key': 'gen-1' }).expect(409);
      const b = await request(app).post(`/api/v1/builds/${blocked}/generate`).set({ ...atlas, 'Idempotency-Key': 'gen-1' }).expect(409);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.error.message).toBe(a.body.error.message);

      await db().idempotencyKey.create({ data: { userId: 'user_atlas', key: 'busy', requestHash: 'x' } });
      // Different hash → refused as reuse; same hash while running → in progress.
      await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'busy' }).send(body).expect(422);
      const running = await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'gen-running' }).send(body);
      expect(running.status).toBe(201);
      await db().idempotencyKey.update({ where: { userId_key: { userId: 'user_atlas', key: 'gen-running' } }, data: { statusCode: null, responseBody: undefined, lockedAt: new Date() } });
      expect((await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'gen-running' }).send(body).expect(409)).body.error.code).toBe('idempotency_in_progress');
      // A request that died long ago is taken over.
      await db().idempotencyKey.update({ where: { userId_key: { userId: 'user_atlas', key: 'gen-running' } }, data: { lockedAt: new Date(Date.now() - 20 * 60_000) } });
      await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'gen-running' }).send(body).expect(201);
    });

    it('scopes keys per account and validates them', async () => {
      await request(app).post('/api/v1/builds').set({ ...bearer(otherKey), 'Idempotency-Key': 'build-1' }).send({ intent, source_version_ids: PASSING }).expect(201);
      await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'x'.repeat(256) }).send(body).expect(400);
      await request(app).post('/api/v1/builds').set({ ...atlas, 'Idempotency-Key': 'has space' }).send(body).expect(400);
    });
  });

  describe('errors', () => {
    it('names the invalid parameter', async () => {
      const res = await request(app).post('/api/v1/builds').set(atlas).send({ intent: { ...intent, price_cents: -1 }, source_version_ids: PASSING }).expect(400);
      expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code: 'parameter_invalid', param: 'intent.price_cents' });
    });

    it('answers malformed JSON with 400, here and on the dashboard API', async () => {
      const v1 = await request(app).post('/api/v1/builds').set({ ...atlas, 'Content-Type': 'application/json' }).send('{"intent":').expect(400);
      expect(v1.body.error.code).toBe('invalid_json');
      await request(app).post('/api/builds/preflight').set({ 'X-Demo-User': 'user_atlas', Origin: TEST_ORIGIN, 'Content-Type': 'application/json' }).send('{oops').expect(400);
    });

    it('404s unknown routes in the same shape', async () => {
      expect((await request(app).get('/api/v1/nope').set(atlas).expect(404)).body.error.code).toBe('route_not_found');
    });
  });

  describe('rate limits', () => {
    it('limits per API key, with Retry-After, without affecting other keys', async () => {
      const limited = testApp(paypal, { apiRateLimitPerMinute: 3 });
      for (let i = 0; i < 3; i++) await request(limited).get('/api/v1/account').set(atlas).expect(200);
      const res = await request(limited).get('/api/v1/account').set(atlas).expect(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.error.type).toBe('rate_limit_error');
      await request(limited).get('/api/v1/account').set(bearer(otherKey)).expect(200);
    });

    it('slows down key guessing from one address', async () => {
      const guarded = testApp(paypal);
      // An integration that has been working from this address…
      await request(guarded).get('/api/v1/account').set(atlas).expect(200);
      let attempts = 0;
      let status = 401;
      while (status === 401 && attempts < 40) {
        status = (await request(guarded).get('/api/v1/account').set(bearer(`tp_guess${attempts++}`))).status;
      }
      expect(status).toBe(429);
      expect(attempts).toBeGreaterThan(25);
      await request(guarded).get('/api/v1/account').set(bearer('tp_guess-more')).expect(429);
      // …keeps working while the address is throttled, and the guesses never reach the database.
      await request(guarded).get('/api/v1/account').set(atlas).expect(200);
    });
  });

  describe('OpenAPI', () => {
    it('is public and documents every route, with resolvable references', async () => {
      const res = await request(app).get('/api/v1/openapi.json').expect(200);
      const spec = res.body;
      expect(spec.openapi).toBe('3.1.0');
      const ops = Object.entries(spec.paths as Record<string, Record<string, { operationId: string }>>).flatMap(([p, methods]) => Object.entries(methods).map(([m, op]) => ({ key: `${m} ${p}`, id: op.operationId })));
      expect(ops).toHaveLength(routes.length);
      for (const r of routes) expect(ops.map((o) => o.key)).toContain(`${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`);
      expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
      const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
      expect(refs.length).toBeGreaterThan(20);
      for (const ref of refs) expect(spec.components.schemas[ref], ref).toBeDefined();
      expect(JSON.stringify(spec)).not.toContain('$defs');
      expect(Object.keys(spec.webhooks)).toContain('sale.completed');
      expect(spec).toEqual(openApiDocument('http://localhost:4000/api/v1'));
      // Optional bodies are documented as optional; required ones as required.
      expect(spec.paths['/reports/{id}/withdraw'].post.requestBody.required).toBe(false);
      expect(spec.paths['/builds'].post.requestBody.required).toBe(true);
    });
  });
});
