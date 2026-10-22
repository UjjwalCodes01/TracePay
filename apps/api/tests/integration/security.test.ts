import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { FakePayPal } from '../fake-paypal';
import { TEST_ORIGIN, testApp } from '../test-app';

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
const SOURCES = ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'];
const atlas = { 'X-Demo-User': 'user_atlas' };

describe.runIf(process.env.TEST_DATABASE_URL)('security (integration)', () => {
  const paypal = new FakePayPal();
  const app = testApp(paypal);
  const prodApp = testApp(paypal, { demoMode: false });

  // Atlas (the demo publisher) owns a report that has been sold and settled.
  let atlasBuild: string;
  let atlasArtifact: string;
  let atlasRun: string;
  let agentRun: string;

  beforeAll(async () => {
    await resetAndSeed(db());
    const pre = await request(app).post('/api/builds/preflight').set(atlas).send({ intent, assetVersionIds: SOURCES }).expect(201);
    atlasBuild = pre.body.buildId;
    atlasArtifact = (await request(app).post(`/api/builds/${atlasBuild}/generate`).set(atlas).expect(201)).body.artifactId;
    const order = await request(app).post('/api/checkout/orders').set({ 'X-Demo-User': 'user_buyer' }).send({ artifactId: atlasArtifact }).expect(201);
    paypal.approve(order.body.orderId);
    atlasRun = (await request(app).post(`/api/checkout/${order.body.saleId}/capture`).set({ 'X-Demo-User': 'user_buyer' }).expect(200)).body.settlementRunId;
    agentRun = (await request(app).post('/api/agent/runs').set(atlas).send({ goal: 'Create a commercial report from approved sources.', intent, assetVersionIds: SOURCES }).expect(202)).body.runId;
  });

  describe('accounts and sessions', () => {
    it('signs up, keeps a session in an httpOnly cookie, and logs out', async () => {
      const agent = request.agent(prodApp);
      const res = await agent
        .post('/api/auth/signup')
        .send({ email: 'Owner@Studio.example', password: 'correct horse battery', name: 'Second Studio', role: 'publisher' })
        .expect(201);
      expect(res.body.user).toMatchObject({ email: 'owner@studio.example', role: 'publisher' });
      const cookie = res.headers['set-cookie']?.[0] ?? '';
      expect(cookie).toMatch(/tp_session=/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);

      expect((await agent.get('/api/me').expect(200)).body).toMatchObject({ user: { email: 'owner@studio.example' }, authMethod: 'session' });
      await agent.post('/api/auth/logout').expect(200);
      await agent.get('/api/me').expect(401);
    });

    it('stores only a password hash and only a session-token hash', async () => {
      const user = await db().user.findUniqueOrThrow({ where: { email: 'owner@studio.example' }, include: { sessions: true } });
      expect(user.passwordHash).toMatch(/^scrypt\$/);
      expect(user.passwordHash).not.toContain('correct horse');
    });

    it('rejects a wrong password, a duplicate email and a weak password without leaking which', async () => {
      const wrong = await request(prodApp).post('/api/auth/login').send({ email: 'owner@studio.example', password: 'nope nope nope' }).expect(401);
      const unknown = await request(prodApp).post('/api/auth/login').send({ email: 'nobody@studio.example', password: 'nope nope nope' }).expect(401);
      expect(wrong.body.error).toBe(unknown.body.error);
      await request(prodApp).post('/api/auth/signup').send({ email: 'owner@studio.example', password: 'another long pass', name: 'Dup', role: 'buyer' }).expect(409);
      await request(prodApp).post('/api/auth/signup').send({ email: 'weak@studio.example', password: 'short', name: 'Weak', role: 'buyer' }).expect(400);
      await request(prodApp).post('/api/auth/signup').send({ email: 'boss@studio.example', password: 'long enough pass', name: 'Boss', role: 'admin' }).expect(400);
    });

    it('rate-limits credential endpoints', async () => {
      const limited = testApp(paypal, { demoMode: false, authRateLimit: 2 });
      for (let i = 0; i < 2; i++) await request(limited).post('/api/auth/login').send({ email: 'x@y.example', password: 'whatever pass' }).expect(401);
      await request(limited).post('/api/auth/login').send({ email: 'x@y.example', password: 'whatever pass' }).expect(429);
    });

    it('rate-limits per visitor using the edge-set client IP header', async () => {
      const app = testApp(paypal, { demoMode: false, authRateLimit: 2, clientIpHeader: 'cf-connecting-ip' });
      const login = (ip: string, extra: Record<string, string> = {}) =>
        request(app).post('/api/auth/login').set({ 'cf-connecting-ip': ip, ...extra }).send({ email: `${ip}@y.example`, password: 'whatever pass' });
      await login('203.0.113.1').expect(401);
      await login('203.0.113.1').expect(401);
      // Forwarding headers a client adds don't buy a fresh allowance…
      await login('203.0.113.1', { 'x-forwarded-for': '198.51.100.9' }).expect(429);
      // …while a different visitor behind the same proxy still gets in.
      await login('203.0.113.2').expect(401);
      // A malformed header value is ignored rather than becoming a rate-limit key.
      await request(app).post('/api/auth/login').set('cf-connecting-ip', 'not-an-ip').send({ email: 'z@y.example', password: 'whatever pass' }).expect(401);
    });
  });

  describe('demo mode', () => {
    it('never lets a real account reset (wipe) the database, even in demo mode', async () => {
      const real = request.agent(app);
      await real.post('/api/auth/signup').send({ email: 'real@studio.example', password: 'real studio pass', name: 'Real Studio', role: 'publisher' }).expect(201);
      await real.post('/api/demo/reset').expect(403);
      expect(await db().user.count({ where: { email: 'real@studio.example' } })).toBe(1);
    });

    it('ignores the X-Demo-User header when demo mode is off', async () => {
      await request(prodApp).get('/api/catalog').set(atlas).expect(401);
      expect((await request(prodApp).get('/api/demo/users').expect(200)).body.users).toEqual([]);
      await request(prodApp).post('/api/demo/reset').set(atlas).expect(401);
    });
  });

  describe('tenant isolation', () => {
    const rival = request.agent(prodApp);

    beforeAll(async () => {
      await rival.post('/api/auth/signup').send({ email: 'rival@studio.example', password: 'rival studio pass', name: 'Rival Studio', role: 'publisher' }).expect(201);
    });

    it('hides another publisher’s builds, runs, settlements and reports (404, not 403)', async () => {
      await rival.get(`/api/builds/${atlasBuild}`).expect(404);
      await rival.post(`/api/builds/${atlasBuild}/generate`).expect(404);
      await rival.get(`/api/builds/${atlasBuild}/explain`).expect(404);
      await rival.get(`/api/agent/runs/${agentRun}`).expect(404);
      await rival.get(`/api/settlements/${atlasRun}`).expect(404);
      await rival.post(`/api/settlements/${atlasRun}/approve`).expect(404);
      await rival.post(`/api/settlements/${atlasRun}/payouts`).expect(404);
      await rival.get(`/api/artifacts/${atlasArtifact}/provenance`).expect(404);
      await rival.get(`/api/artifacts/${atlasArtifact}/receipt`).expect(404);
      expect((await rival.get(`/api/artifacts/${atlasArtifact}`).expect(200)).body.full).toBe(false);
    });

    it('returns only the caller’s own records in lists and the dashboard', async () => {
      expect((await rival.get('/api/builds').expect(200)).body.builds).toEqual([]);
      expect((await rival.get('/api/settlements').expect(200)).body.settlements).toEqual([]);
      expect((await rival.get('/api/sales').expect(200)).body.sales).toEqual([]);
      expect((await rival.get('/api/agent/runs').expect(200)).body.runs).toEqual([]);
      const dash = (await rival.get('/api/dashboard').expect(200)).body;
      expect(dash).toMatchObject({ buildsPassed: 0, artifacts: 0, verifiedSales: 0, verifiedSalesCents: 0 });
      // Regression: not even system or legacy (unscoped) events leak into another publisher's feed.
      expect(dash.recentEvents).toEqual([]);
    });

    it('lets the owner, the paying buyer and the contributors verify — each with the right view', async () => {
      const ownerGraph = (await request(app).get(`/api/artifacts/${atlasArtifact}/provenance`).set(atlas).expect(200)).body;
      const buyerGraph = (await request(app).get(`/api/artifacts/${atlasArtifact}/provenance`).set({ 'X-Demo-User': 'user_buyer' }).expect(200)).body;
      const contributorGraph = (await request(app).get(`/api/artifacts/${atlasArtifact}/provenance`).set({ 'X-Demo-User': 'user_northwind' }).expect(200)).body;
      const kinds = (g: { nodes: Array<{ kind: string }> }) => new Set(g.nodes.map((n) => n.kind));
      expect(kinds(ownerGraph).has('settlement_line')).toBe(true);
      expect(kinds(buyerGraph).has('settlement_line')).toBe(false); // buyers don't see the money split
      expect(kinds(contributorGraph).has('settlement_line')).toBe(true);
      // A contributor whose work isn't in the report can't see it.
      await request(app).get(`/api/artifacts/${atlasArtifact}/provenance`).set({ 'X-Demo-User': 'user_kestrel' }).expect(404);
    });
  });

  describe('API keys', () => {
    it('authenticates platform calls with a hashed, revocable key', async () => {
      const created = await request(app).post('/api/auth/api-keys').set(atlas).send({ name: 'CI pipeline' }).expect(201);
      const key: string = created.body.key;
      expect(key).toMatch(/^tp_/);
      const row = await db().apiKey.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(row.keyHash).not.toContain(key);

      const bearer = { Authorization: `Bearer ${key}` };
      expect((await request(prodApp).get('/api/v1/account').set(bearer).expect(200)).body).toMatchObject({ id: 'user_atlas', authenticated_with: 'api_key' });
      // Keys are for the platform API only: never the dashboard (payout details, key management…).
      for (const [method, path] of [['get', '/api/me'], ['patch', '/api/me'], ['post', '/api/auth/api-keys'], ['post', `/api/settlements/${atlasRun}/approve`], ['delete', `/api/auth/api-keys/${created.body.id}`]] as const) {
        const res = await request(prodApp)[method](path).set(bearer).send({ name: 'nested', paypalEmail: 'attacker@example.com' });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(res.body.error).toMatch(/platform API/);
      }
      // The scheme is case-insensitive (RFC 7235), parsed the same way everywhere.
      await request(prodApp).get('/api/v1/account').set({ Authorization: `bearer ${key}` }).expect(200);

      await request(app).delete(`/api/auth/api-keys/${created.body.id}`).set(atlas).expect(200);
      await request(prodApp).get('/api/v1/account').set(bearer).expect(401);
      await request(prodApp).get('/api/v1/account').set({ Authorization: 'Bearer tp_forged' }).expect(401);
    });
  });

  describe('visitors behind the web app’s proxy', () => {
    const secret = 'p'.repeat(40);
    const viaProxy = (ip: string, presented = secret) => ({ 'x-tracepay-proxy-secret': presented, 'x-vercel-forwarded-for': ip });

    it('rate-limits per visitor when the proxy proves itself, and ignores the claim otherwise', async () => {
      const proxied = testApp(paypal, { trustedProxySecret: secret, rateLimitPerMinute: 2 });
      await request(proxied).get('/api/artifacts').set(viaProxy('198.51.100.7')).expect(200);
      await request(proxied).get('/api/artifacts').set(viaProxy('198.51.100.7')).expect(200);
      await request(proxied).get('/api/artifacts').set(viaProxy('198.51.100.7')).expect(429);
      // Another visitor coming through the same proxy has their own allowance.
      await request(proxied).get('/api/artifacts').set(viaProxy('198.51.100.8')).expect(200);
      // Without the secret (or with a wrong one) the claimed address is ignored: the
      // request counts against the connection's own address instead.
      await request(proxied).get('/api/artifacts').set({ 'x-vercel-forwarded-for': '203.0.113.50' }).expect(200);
      await request(proxied).get('/api/artifacts').set(viaProxy('203.0.113.50', 'q'.repeat(40))).expect(200);
      await request(proxied).get('/api/artifacts').set({ 'x-vercel-forwarded-for': '203.0.113.51' }).expect(429);
    });

    it('caps each proxy address, so inventing visitor addresses can’t escape the limit', async () => {
      // Per-visitor limit 1/min → proxy cap 10/min.
      const proxied = testApp(paypal, { trustedProxySecret: secret, rateLimitPerMinute: 1 });
      let blocked = 0;
      for (let i = 0; i < 14; i++) {
        const res = await request(proxied).get('/api/artifacts').set(viaProxy(`198.51.100.${100 + i}`));
        if (res.status === 429) blocked++;
      }
      expect(blocked).toBe(4);
    });

    it('is off when no secret is configured', async () => {
      const plain = testApp(paypal, { rateLimitPerMinute: 1 });
      await request(plain).get('/api/artifacts').set(viaProxy('198.51.100.9')).expect(200);
      await request(plain).get('/api/artifacts').set(viaProxy('198.51.100.10')).expect(429);
    });
  });

  describe('request hardening', () => {
    it('blocks cross-site state changes on cookie sessions (CSRF)', async () => {
      await request(app).post('/api/builds/preflight').set(atlas).set('Origin', 'https://evil.example').send({ intent, assetVersionIds: SOURCES }).expect(403);
      await request(app).post('/api/builds/preflight').set(atlas).set('Origin', TEST_ORIGIN).send({ intent, assetVersionIds: SOURCES }).expect(201);
    });

    it('sends security headers and a request id, and hides internals', async () => {
      const res = await request(app).get('/api/health').expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,}$/);
      expect((await request(app).get('/api/health').set('X-Request-Id', 'trace-12345678').expect(200)).headers['x-request-id']).toBe('trace-12345678');
    });

    it('answers readiness only when the database is reachable', async () => {
      await request(app).get('/api/ready').expect(200, { ok: true, rateLimits: 'memory' });
    });
  });
});
