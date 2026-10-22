import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { FakePayPal } from '../fake-paypal';

/**
 * Rate limits shared through Redis (Render Key Value in production). Runs when
 * TEST_REDIS_URL points at a Redis: e.g. `npm run db:up` starts one on :6380.
 */
describe.runIf(process.env.TEST_REDIS_URL)('rate limits shared through Redis', async () => {
  // Before anything creates the shared client.
  process.env.REDIS_URL = process.env.TEST_REDIS_URL;
  const { testApp } = await import('../test-app');
  const { closeLimitStore, limitStoreStatus } = await import('../../src/http/rate-store');
  const { createClient } = await import('redis');

  // A fresh window for this run: other runs used the same keys.
  const admin = createClient({ url: process.env.TEST_REDIS_URL });
  await admin.connect();
  for await (const keys of admin.scanIterator({ MATCH: 'tracepay:rl:*', COUNT: 500 })) if (keys.length) await admin.del(keys);

  afterAll(async () => {
    await admin.close();
    await closeLimitStore();
  });

  it('counts one limit across two API instances, as when Render runs two', async () => {
    const paypal = new FakePayPal();
    const a = testApp(paypal, { rateLimitPerMinute: 3 });
    const b = testApp(paypal, { rateLimitPerMinute: 3 });
    for (let i = 0; i < 30 && limitStoreStatus() !== 'shared'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(limitStoreStatus()).toBe('shared');

    await request(a).get('/api/config').expect(200);
    await request(b).get('/api/config').expect(200);
    await request(a).get('/api/config').expect(200);
    // The fourth request is over the limit, even though each instance has only seen two.
    const blocked = await request(b).get('/api/config').expect(429);
    expect(blocked.body.error).toBe('Too many requests. Please slow down.');
    expect((await request(a).get('/api/ready').expect(200)).body.rateLimits).toBe('shared');
  });

  it('fails open when Redis goes away', async () => {
    await closeLimitStore();
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens there
    const app = testApp(new FakePayPal(), { rateLimitPerMinute: 1 });
    await request(app).get('/api/config').expect(200);
    await request(app).get('/api/config').expect(200); // limit 1, but the store is down: let through
    expect((await request(app).get('/api/ready').expect(200)).body.rateLimits).toBe('unavailable');
  });
});
