import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { createApiKey } from '../../src/modules/auth/auth.service';
import { appendAudit } from '../../src/modules/audit/audit-log';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { softResetDemo } from '../../src/modules/demo/soft-reset';
import { setOutboxListener } from '../../src/modules/platform/events';
import type { Lookup } from '../../src/modules/platform/safe-http';
import { verifyWebhookSignature } from '../../src/modules/platform/webhook-crypto';
import {
  deliverDue, DISABLE_AFTER_MS, MAX_ATTEMPTS, MAX_ENDPOINTS_PER_ACCOUNT, nextDueAt, pruneWebhookData, RETRY_DELAYS_MS, WebhookDispatcher,
} from '../../src/modules/platform/webhooks';
import { recordPublicEvent } from '../../src/modules/platform/events';
import { AgentStateError, cancelRun, createRunWithinCap, TooManyRunsError } from '../../src/modules/agent/agent.service';
import { recoverStaleWork } from '../../src/modules/maintenance/recovery';
import type { AgentPlanner } from '../../src/modules/agent/planners';
import { createApp } from '../../src/app';
import { FakePayPal } from '../fake-paypal';
import { testApp, testDeps, testWebhookBox, testWebhookDeps } from '../test-app';
import { resetQuotas } from '../../src/http/limits';
import { WebhookReceiver } from '../webhook-receiver';

const intent = {
  title: 'Webhook test report',
  brief: 'A report used to exercise outbound webhooks end to end.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includes_raw_data: false,
  territory: 'US',
  price_cents: 2000,
  currency: 'USD',
};
const PASSING = ['asset_northwind_index_v1', 'asset_okafor_notes_v1', 'asset_lumen_digest_v1'];

describe.runIf(process.env.TEST_DATABASE_URL)('outbound webhooks (integration)', () => {
  const paypal = new FakePayPal();
  const app = testApp(paypal);
  const strictApp = testApp(paypal, {}, { policy: { allowHttp: false, allowPrivate: false } });
  const receiver = new WebhookReceiver();
  const deps = testWebhookDeps();
  let atlas: Record<string, string>;
  let reportId: string;

  const later = (ms: number) => () => new Date(Date.now() + ms);
  const createEndpoint = async (events: string[] = ['*'], path = '/hooks') =>
    (await request(app).post('/api/v1/webhook_endpoints').set(atlas).send({ url: receiver.url(path), enabled_events: events }).expect(201)).body as { id: string; secret: string };
  const withdraw = () => request(app).post(`/api/v1/reports/${reportId}/withdraw`).set(atlas).expect(200);
  const relist = () => request(app).post(`/api/v1/reports/${reportId}/relist`).set(atlas).expect(200);
  const deliveries = (endpointId: string) => db().webhookDelivery.findMany({ where: { endpointId }, include: { event: true }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    await receiver.start();
    await resetAndSeed(db());
    atlas = { Authorization: `Bearer ${(await createApiKey(db(), 'user_atlas', 'hooks')).key}` };
    const build = await request(app).post('/api/v1/builds').set(atlas).send({ intent, source_version_ids: PASSING }).expect(201);
    reportId = (await request(app).post(`/api/v1/builds/${build.body.id}/generate`).set(atlas).expect(201)).body.report.id;
  });
  afterAll(() => receiver.stop());
  beforeEach(async () => {
    receiver.reset();
    await resetQuotas('user_atlas');
    await db().webhookEndpoint.deleteMany({ where: { ownerId: 'user_atlas' } });
    // Every test starts from a listed report (a failed test must not cascade).
    await db().artifact.update({ where: { id: reportId }, data: { status: 'listed' } });
  });

  describe('endpoints', () => {
    it('returns the signing secret once, and stores it encrypted', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      expect(ep.secret).toMatch(/^whsec_/);
      const fetched = await request(app).get(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).expect(200);
      expect(fetched.body).not.toHaveProperty('secret');
      expect((await request(app).get('/api/v1/webhook_endpoints').set(atlas).expect(200)).body.data[0]).not.toHaveProperty('secret');
      const row = await db().webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(row.secretEnc).not.toContain(ep.secret);
      expect(testWebhookBox.open(row.secretEnc)).toBe(ep.secret);
    });

    it('validates URLs and event types', async () => {
      const bad = async (body: object, code = 400) => request(app).post('/api/v1/webhook_endpoints').set(atlas).send(body).expect(code);
      await bad({ url: 'ftp://x.example', enabled_events: ['*'] });
      await bad({ url: 'https://u:p@x.example', enabled_events: ['*'] });
      await bad({ url: 'https://x.example', enabled_events: [] });
      await bad({ url: 'https://x.example', enabled_events: ['*', 'sale.completed'] });
      expect((await bad({ url: 'https://x.example', enabled_events: ['sale.made_up'] })).body.error.message).toMatch(/Unknown event type/);
      // In production, private and plain-http targets are refused.
      for (const url of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://localhost/x', 'https://169.254.169.254/x']) {
        expect((await request(strictApp).post('/api/v1/webhook_endpoints').set(atlas).send({ url, enabled_events: ['*'] })).status, url).toBe(400);
      }
    });

    it('refuses duplicates and caps the number per account', async () => {
      await createEndpoint(['*'], '/a');
      expect((await request(app).post('/api/v1/webhook_endpoints').set(atlas).send({ url: receiver.url('/a'), enabled_events: ['*'] }).expect(409)).body.error.code).toBe('conflict');
      for (let i = 1; i < MAX_ENDPOINTS_PER_ACCOUNT; i++) await createEndpoint(['*'], `/n${i}`);
      expect((await request(app).post('/api/v1/webhook_endpoints').set(atlas).send({ url: receiver.url('/one-more'), enabled_events: ['*'] }).expect(409)).body.error.code).toBe('resource_limit');
    });

    it('updates, disables and deletes', async () => {
      const ep = await createEndpoint();
      await request(app).patch(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).send({}).expect(400);
      const upd = await request(app).patch(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).send({ enabled_events: ['sale.completed', 'report.created'], description: 'Main' }).expect(200);
      expect(upd.body).toMatchObject({ enabled_events: ['report.created', 'sale.completed'], description: 'Main' });
      expect((await request(app).patch(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).send({ status: 'disabled' }).expect(200)).body.disabled_reason).toBe('Disabled by you.');
      await request(app).delete(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).expect(200).expect((r) => expect(r.body).toEqual({ id: ep.id, object: 'webhook_endpoint', deleted: true }));
      await request(app).delete(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).expect(404);
    });

    it('keeps endpoints private to their account', async () => {
      const ep = await createEndpoint();
      const theirs = { Authorization: `Bearer ${(await createApiKey(db(), 'user_admin', 'x')).key}` };
      await request(app).get(`/api/v1/webhook_endpoints/${ep.id}`).set(theirs).expect(404);
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(theirs).expect(404);
      expect((await request(app).get('/api/v1/webhook_endpoints').set(theirs).expect(200)).body.data).toEqual([]);
    });
  });

  describe('deliveries', () => {
    it('queues events in the same transaction, only for subscribed endpoints, and delivers them signed', async () => {
      const subscribed = await createEndpoint(['report.withdrawn']);
      const other = await createEndpoint(['sale.completed'], '/other');
      await withdraw();
      expect(await deliveries(other.id)).toHaveLength(0);
      const [queued] = await deliveries(subscribed.id);
      expect(queued).toMatchObject({ status: 'pending', attempts: 0 });

      expect(await deliverDue(deps)).toBe(1);
      expect(receiver.received).toHaveLength(1);
      const hit = receiver.received[0]!;
      expect(verifyWebhookSignature({ header: hit.headers['tracepay-signature'] as string, body: hit.body, secret: subscribed.secret })).toBe(true);
      expect(verifyWebhookSignature({ header: hit.headers['tracepay-signature'] as string, body: hit.body, secret: other.secret })).toBe(false);
      const event = JSON.parse(hit.body);
      expect(event).toMatchObject({ object: 'event', type: 'report.withdrawn', api_version: 'v1', sandbox: true, data: { object_type: 'report', object_id: reportId } });
      expect(hit.headers).toMatchObject({ 'tracepay-event-id': event.id, 'tracepay-event-type': 'report.withdrawn', 'tracepay-delivery-attempt': '1', 'content-type': 'application/json' });
      expect((await deliveries(subscribed.id))[0]).toMatchObject({ status: 'succeeded', attempts: 1, lastStatusCode: 200 });
      // The event is also in the log, with the same id.
      await request(app).get(`/api/v1/events/${event.id}`).set(atlas).expect(200);
      await relist();
    });

    it('writes no event when the transaction rolls back', async () => {
      await createEndpoint();
      const before = await db().outboundEvent.count();
      await expect(
        db().$transaction(async (tx) => {
          await appendAudit(tx, { entityType: 'artifact', entityId: reportId, artifactId: reportId, eventType: 'artifact.relisted', payload: {} });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await db().outboundEvent.count()).toBe(before);
      expect(await db().webhookDelivery.count({ where: { status: 'pending' } })).toBe(0);
    });

    it('retries failures with backoff, then gives up', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      receiver.status(500, 'down');
      await withdraw();
      await deliverDue(deps);
      let [d] = await deliveries(ep.id);
      expect(d).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500 });
      expect(d!.lastError).toMatch(/HTTP 500 — down/);
      const delay = d!.nextAttemptAt!.getTime() - d!.lastAttemptAt!.getTime();
      expect(delay).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[0]! * 0.9);
      expect(delay).toBeLessThanOrEqual(RETRY_DELAYS_MS[0]! * 1.1);
      // Not due yet: nothing is sent.
      expect(await deliverDue(deps)).toBe(0);

      // Step through the real schedule (each delay plus jitter headroom): ~1.2 days in all,
      // so a single event can never trip the 3-day auto-disable.
      let offset = 0;
      for (let i = 2; i <= MAX_ATTEMPTS; i++) {
        offset += RETRY_DELAYS_MS[i - 2]! * 1.1 + 1_000;
        expect(await deliverDue(deps, { now: later(offset) }), `attempt ${i}`).toBe(1);
      }
      expect(await db().webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ status: 'enabled', consecutiveFailures: MAX_ATTEMPTS });
      [d] = await deliveries(ep.id);
      expect(d).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, nextAttemptAt: null });
      expect((d!.history as unknown[]).length).toBe(MAX_ATTEMPTS);
      expect(receiver.received.map((r) => r.headers['tracepay-delivery-attempt'])).toEqual(Array.from({ length: MAX_ATTEMPTS }, (_, i) => String(i + 1)));
      // Every attempt carries the same event id, so receivers can de-duplicate.
      expect(new Set(receiver.received.map((r) => r.headers['tracepay-event-id'])).size).toBe(1);
      await relist();
    });

    it('treats redirects as failures and does not follow them', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      receiver.respond((_req, res) => res.writeHead(301, { location: 'http://169.254.169.254/' }).end());
      await withdraw();
      await deliverDue(deps);
      expect((await deliveries(ep.id))[0]!.lastError).toMatch(/redirects are not followed/);
      expect(receiver.received).toHaveLength(1);
      await relist();
    });

    it('stops at once and disables the endpoint on 410 Gone', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      receiver.status(410);
      await withdraw();
      await deliverDue(deps);
      expect((await deliveries(ep.id))[0]).toMatchObject({ status: 'failed' });
      expect(await db().webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ status: 'disabled', disabledReason: expect.stringMatching(/410/) });
      await relist();
    });

    it('disables an endpoint that has failed for days, and resets the streak on success', async () => {
      const ep = await createEndpoint(['report.withdrawn', 'report.relisted']);
      receiver.status(503);
      await withdraw();
      await deliverDue(deps);
      expect(await db().webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ status: 'enabled', consecutiveFailures: 1 });
      await db().webhookEndpoint.update({ where: { id: ep.id }, data: { consecutiveFailures: 10, failingSince: new Date(Date.now() - DISABLE_AFTER_MS - 1000) } });
      await deliverDue(deps, { now: later(10 * 60_000) });
      const disabled = await db().webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(disabled).toMatchObject({ status: 'disabled', disabledReason: expect.stringMatching(/3 days/) });

      // A delivery queued before the endpoint was disabled is skipped, not sent…
      receiver.reset();
      await deliverDue(deps, { now: later(3 * 3_600_000) });
      const skipped = (await deliveries(ep.id)).find((d) => d.event.type === 'report.withdrawn')!;
      expect(skipped.status).toBe('skipped');
      expect(receiver.received).toHaveLength(0);
      // …and events that happen while it is disabled aren't queued for it at all.
      await relist();
      expect((await deliveries(ep.id)).some((d) => d.event.type === 'report.relisted')).toBe(false);
      await request(app).post(`/api/v1/webhook_deliveries/${skipped.id}/retry`).set(atlas).expect(409);

      // Re-enabling clears the streak; the skipped delivery can then be retried.
      const enabled = await request(app).patch(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).send({ status: 'enabled' }).expect(200);
      expect(enabled.body).toMatchObject({ status: 'enabled', consecutive_failures: 0, failing_since: null, disabled_reason: null });
      await request(app).post(`/api/v1/webhook_deliveries/${skipped.id}/retry`).set(atlas).expect(202);
      await deliverDue(deps);
      expect((await db().webhookDelivery.findUniqueOrThrow({ where: { id: skipped.id } })).status).toBe('succeeded');
      expect(receiver.received).toHaveLength(1);
    });

    it('blocks private targets at delivery time (DNS rebinding included)', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      await withdraw();
      // The same queued delivery, sent by a production-configured worker: refused before connecting.
      await deliverDue(testWebhookDeps({ policy: { allowHttp: true, allowPrivate: false } }));
      expect((await deliveries(ep.id))[0]!.lastError).toMatch(/private or reserved/);
      expect(receiver.received).toHaveLength(0);

      // A hostname that looked public when saved but resolves to loopback at send time.
      await db().webhookEndpoint.update({ where: { id: ep.id }, data: { url: `http://rebind.example.test:${receiver.port}/hooks` } });
      const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as Lookup;
      await deliverDue(testWebhookDeps({ policy: { allowHttp: true, allowPrivate: false }, lookup: toLoopback }), { now: later(2 * 3_600_000) });
      expect((await deliveries(ep.id))[0]!.lastError).toMatch(/resolves to a private or reserved address/);
      expect(receiver.received).toHaveLength(0);
      await relist();
    });

    it('never sends the same delivery twice, even with many concurrent workers', async () => {
      // A race: repeat it, with more workers than deliveries, so a lucky interleaving can't hide it.
      for (let round = 0; round < 5; round++) {
        receiver.reset();
        await db().webhookEndpoint.deleteMany({ where: { ownerId: 'user_atlas' } });
        const ep = await createEndpoint(['report.withdrawn', 'report.relisted'], `/race-${round}`);
        receiver.respond((_req, res) => setTimeout(() => res.writeHead(200).end('ok'), 30));
        await withdraw();
        await relist();
        await withdraw();
        await relist();
        await Promise.all(Array.from({ length: 8 }, () => deliverDue(deps, { batchSize: 1 })));
        const ds = await deliveries(ep.id);
        expect(ds).toHaveLength(4);
        expect(ds.every((d) => d.status === 'succeeded' && d.attempts === 1), `round ${round}`).toBe(true);
        expect(receiver.received, `round ${round}`).toHaveLength(4);
        expect(new Set(receiver.received.map((r) => r.headers['tracepay-delivery-id'])).size).toBe(4);
      }
    });

    it('honours leases: a claimed delivery is left alone until its lease expires', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      await withdraw();
      const [d] = await deliveries(ep.id);
      await db().webhookDelivery.update({ where: { id: d!.id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
      expect(await deliverDue(deps)).toBe(0);
      // The worker holding it crashed: once the lease runs out, another one sends it.
      expect(await deliverDue(deps, { now: later(61_000) })).toBe(1);
      expect(receiver.received).toHaveLength(1);
      await relist();
    });
  });

  describe('test events, secret rotation and redelivery', () => {
    it('sends a ping on request and reports how the endpoint answered', async () => {
      const ep = await createEndpoint(['sale.completed']);
      const res = await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      expect(res.body).toMatchObject({ object: 'webhook_delivery', event_type: 'ping', status: 'succeeded', last_status_code: 200, attempts: 1 });
      expect(JSON.parse(receiver.received[0]!.body)).toMatchObject({ type: 'ping', data: { object_type: 'webhook_endpoint', object_id: ep.id } });
      receiver.status(500, 'nope');
      const failed = await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      // A ping is sent once: it reports how the endpoint answers now and doesn't affect its health.
      expect(failed.body).toMatchObject({ status: 'failed', last_status_code: 500, attempts: 1, next_attempt_at: null });
      receiver.status(410);
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      expect(await db().webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ status: 'enabled', consecutiveFailures: 0 });
      await request(app).patch(`/api/v1/webhook_endpoints/${ep.id}`).set(atlas).send({ status: 'disabled' }).expect(200);
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(409);
    });

    it('signs with both secrets during a rotation, then only the new one', async () => {
      const ep = await createEndpoint(['ping']);
      const rotated = await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/rotate_secret`).set(atlas).send({}).expect(200);
      expect(rotated.body.secret).not.toBe(ep.secret);
      expect(rotated.body.previous_secret_expires_at).not.toBeNull();
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      const both = receiver.received[0]!;
      for (const secret of [ep.secret, rotated.body.secret]) {
        expect(verifyWebhookSignature({ header: both.headers['tracepay-signature'] as string, body: both.body, secret })).toBe(true);
      }
      const now = await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/rotate_secret`).set(atlas).send({ previous_secret_valid_hours: 0 }).expect(200);
      receiver.reset();
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      const only = receiver.received[0]!;
      expect(verifyWebhookSignature({ header: only.headers['tracepay-signature'] as string, body: only.body, secret: now.body.secret })).toBe(true);
      expect(verifyWebhookSignature({ header: only.headers['tracepay-signature'] as string, body: only.body, secret: rotated.body.secret })).toBe(false);
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/rotate_secret`).set(atlas).send({ previous_secret_valid_hours: 999 }).expect(400);
    });

    it('resends a past event to an endpoint created later', async () => {
      await withdraw();
      const event = (await request(app).get('/api/v1/events?type=report.withdrawn&limit=1').set(atlas).expect(200)).body.data[0];
      const ep = await createEndpoint(['sale.completed']);
      const queued = await request(app).post(`/api/v1/events/${event.id}/resend`).set(atlas).send({ endpoint_id: ep.id }).expect(202);
      expect(queued.body).toMatchObject({ event_id: event.id, endpoint_id: ep.id, status: 'pending' });
      await deliverDue(deps);
      expect(JSON.parse(receiver.received[0]!.body).id).toBe(event.id);
      // Resending again re-queues the same delivery rather than creating a duplicate.
      await request(app).post(`/api/v1/events/${event.id}/resend`).set(atlas).send({ endpoint_id: ep.id }).expect(202);
      expect(await db().webhookDelivery.count({ where: { eventId: event.id, endpointId: ep.id } })).toBe(1);
      await request(app).post(`/api/v1/events/evt_missing/resend`).set(atlas).send({ endpoint_id: ep.id }).expect(404);
      await relist();
    });

    it('lists an endpoint’s deliveries, filterable by status', async () => {
      const ep = await createEndpoint(['ping']);
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      receiver.status(500);
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      const all = await request(app).get(`/api/v1/webhook_endpoints/${ep.id}/deliveries`).set(atlas).expect(200);
      expect(all.body.data).toHaveLength(2);
      const failed = await request(app).get(`/api/v1/webhook_endpoints/${ep.id}/deliveries?status=failed`).set(atlas).expect(200);
      expect(failed.body.data).toHaveLength(1);
      expect(failed.body.data[0].history[0]).toMatchObject({ attempt: 1, status_code: 500 });
    });
  });

  describe('background delivery and housekeeping', () => {
    it('the dispatcher delivers on its own once kicked', async () => {
      await createEndpoint(['report.withdrawn']);
      const dispatcher = new WebhookDispatcher(() => deps, { pollMs: 50, eventWindowMs: 2_000 });
      setOutboxListener(() => dispatcher.kick('event'));
      try {
        await withdraw(); // the outbox listener kicks the dispatcher
        for (let i = 0; i < 50 && receiver.received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
        expect(receiver.received).toHaveLength(1);
      } finally {
        dispatcher.stop();
        setOutboxListener(null);
        await relist();
      }
    });

    it('prunes old events and idempotency records, but never undelivered events', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      receiver.status(500);
      await withdraw();
      const old = new Date(Date.now() - 40 * 86_400_000);
      await db().outboundEvent.updateMany({ data: { createdAt: old } });
      await db().idempotencyKey.create({ data: { userId: 'user_atlas', key: 'ancient-done', requestHash: 'x', statusCode: 201, createdAt: old, lockedAt: old } });
      await db().idempotencyKey.create({ data: { userId: 'user_atlas', key: 'ancient-crashed', requestHash: 'x', createdAt: old, lockedAt: old } });
      // Old but still heartbeating: its request is running right now.
      await db().idempotencyKey.create({ data: { userId: 'user_atlas', key: 'ancient-running', requestHash: 'x', createdAt: old } });
      const result = await pruneWebhookData(db());
      expect(result.idempotencyKeys).toBe(2);
      expect(await db().idempotencyKey.count({ where: { key: 'ancient-running' } })).toBe(1);
      // The event still waiting for its retries survives.
      expect(await db().webhookDelivery.count({ where: { endpointId: ep.id, status: 'pending' } })).toBe(1);
      expect(await db().outboundEvent.count({ where: { deliveries: { none: { status: 'pending' } } } })).toBe(0);
      await relist();
    });

    it('“Reset demo” clears the demo publisher’s endpoints and events, and revokes its keys', async () => {
      await createEndpoint();
      const demoKey = await createApiKey(db(), 'user_atlas', 'left behind by a visitor');
      await softResetDemo(db());
      expect(await db().webhookEndpoint.count({ where: { ownerId: 'user_atlas' } })).toBe(0);
      expect(await db().outboundEvent.count({ where: { ownerId: 'user_atlas' } })).toBe(0);
      expect((await db().apiKey.findUniqueOrThrow({ where: { id: demoKey.id } })).revokedAt).not.toBeNull();
      await request(app).get('/api/v1/account').set({ Authorization: `Bearer ${demoKey.key}` }).expect(401);
      // Restore a key and a report for anything that runs after this.
      atlas = { Authorization: `Bearer ${(await createApiKey(db(), 'user_atlas', 'hooks')).key}` };
      const build = await request(app).post('/api/v1/builds').set(atlas).send({ intent, source_version_ids: PASSING }).expect(201);
      reportId = (await request(app).post(`/api/v1/builds/${build.body.id}/generate`).set(atlas).expect(201)).body.report.id;
    });
  });

  describe('robustness (review regressions)', () => {
    it('stores receiver text safely: a NUL byte in an error page is not a crash loop', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      receiver.status(500, 'bad\u0000gateway\u0007');
      await withdraw();
      expect(await deliverDue(deps)).toBe(1);
      const [d] = await deliveries(ep.id);
      expect(d).toMatchObject({ status: 'pending', attempts: 1 });
      expect(d!.lastError).toContain('badgateway');
      expect(await deliverDue(deps)).toBe(0);
      expect(receiver.received).toHaveLength(1);
    });

    it('counts an attempt that crashes, so it is retried with backoff — never in a tight loop', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      await db().webhookEndpoint.update({ where: { id: ep.id }, data: { secretEnc: 'v1.AAAA.AAAA.AAAA' } }); // undecryptable
      await withdraw();
      expect(await deliverDue(deps)).toBe(1);
      const [d] = await deliveries(ep.id);
      expect(d).toMatchObject({ status: 'pending', attempts: 1, lockedUntil: null });
      expect(d!.lastError).toMatch(/Internal error/);
      expect(d!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
      expect(await deliverDue(deps)).toBe(0);
      expect(receiver.received).toHaveLength(0);
    });

    it('counts concurrent failures exactly (atomic streak)', async () => {
      const ep = await createEndpoint(['report.withdrawn', 'report.relisted']);
      receiver.status(503);
      await withdraw();
      await relist();
      await withdraw();
      await deliverDue(deps);
      expect((await db().webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).consecutiveFailures).toBe(3);
    });

    it('a worker that lost its lease does not overwrite the new holder’s result', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      let release: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => receiver.respond((_req, res) => {
        release = () => res.writeHead(200).end('ok');
        resolve();
      }));
      await withdraw();
      const running = deliverDue(deps);
      await arrived;
      const [d] = await deliveries(ep.id);
      const takenOver = new Date(Date.now() + 5 * 60_000);
      await db().webhookDelivery.update({ where: { id: d!.id }, data: { lockedUntil: takenOver } });
      release();
      await running;
      expect(await db().webhookDelivery.findUniqueOrThrow({ where: { id: d!.id } })).toMatchObject({ status: 'pending', attempts: 0, lockedUntil: takenOver });
    });

    it('a test ping is created already claimed, so a background worker can’t steal it', async () => {
      const ep = await createEndpoint(['ping']);
      await db().$transaction((tx) =>
        recordPublicEvent(tx, { auditSeq: null, ownerId: 'user_atlas', type: 'ping', data: {}, createdAt: new Date(), onlyEndpointId: ep.id, leasedUntil: new Date(Date.now() + 60_000) }),
      );
      expect(await deliverDue(deps)).toBe(0);
    });

    it('schedules the next pass by the earliest sendable delivery, not a leased one', async () => {
      const ep = await createEndpoint(['report.withdrawn', 'report.relisted']);
      await withdraw();
      await relist();
      const [a, b] = await deliveries(ep.id);
      const now = new Date();
      await db().webhookDelivery.update({ where: { id: a!.id }, data: { nextAttemptAt: new Date(now.getTime() - 1_000), lockedUntil: new Date(now.getTime() + 60_000) } });
      await db().webhookDelivery.update({ where: { id: b!.id }, data: { nextAttemptAt: new Date(now.getTime() + 5_000), lockedUntil: null } });
      await db().webhookDelivery.updateMany({ where: { id: { notIn: [a!.id, b!.id] }, status: 'pending' }, data: { status: 'skipped' } });
      const next = await nextDueAt(db(), now);
      expect(next!.getTime()).toBe(now.getTime() + 5_000);
    });

    it('handles concurrent resends and rotations without errors or dead secrets', async () => {
      const ep = await createEndpoint(['ping', 'report.withdrawn']);
      await withdraw();
      const event = (await request(app).get('/api/v1/events?type=report.withdrawn&limit=1').set(atlas)).body.data[0];
      const other = await createEndpoint(['sale.completed'], '/later');
      const resends = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/v1/events/${event.id}/resend`).set(atlas).send({ endpoint_id: other.id })));
      expect(resends.map((r) => r.status)).toEqual([202, 202, 202]);
      expect(await db().webhookDelivery.count({ where: { eventId: event.id, endpointId: other.id } })).toBe(1);

      const [r1, r2] = await Promise.all([1, 2].map(() => request(app).post(`/api/v1/webhook_endpoints/${ep.id}/rotate_secret`).set(atlas).send({})));
      receiver.reset();
      await request(app).post(`/api/v1/webhook_endpoints/${ep.id}/test`).set(atlas).expect(200);
      const hit = receiver.received[0]!;
      // Whichever rotation landed second, both secrets handed out still sign.
      for (const secret of [r1!.body.secret, r2!.body.secret]) {
        expect(verifyWebhookSignature({ header: hit.headers['tracepay-signature'] as string, body: hit.body, secret })).toBe(true);
      }
    });

    it('never stores a signing secret for idempotent replay', async () => {
      const headers = { ...atlas, 'Idempotency-Key': `ep-${Date.now()}` };
      const body = { url: receiver.url('/idem'), enabled_events: ['*'] };
      const first = await request(app).post('/api/v1/webhook_endpoints').set(headers).send(body).expect(201);
      expect(first.body.secret).toMatch(/^whsec_/);
      const replay = await request(app).post('/api/v1/webhook_endpoints').set(headers).send(body).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toMatchObject({ id: first.body.id, secret: null });
      const stored = await db().idempotencyKey.findFirstOrThrow({ where: { key: headers['Idempotency-Key'] } });
      expect(JSON.stringify(stored.responseBody)).not.toContain(first.body.secret);
    });

    it('counts runs paused for approval toward the cap', async () => {
      await db().agentRun.updateMany({ where: { publisherId: 'user_atlas', status: { in: ['running', 'awaiting_approval'] } }, data: { status: 'failed' } });
      const planner = { name: 'stub', model: 'none' } as unknown as AgentPlanner;
      const input = { publisherId: 'user_atlas', goal: 'Paused run goal.', intent: {} as never, selection: ['x'], policy: { autoReplace: false } };
      const a = await createRunWithinCap(db(), planner, input, 2);
      const b = await createRunWithinCap(db(), planner, input, 2);
      await db().agentRun.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { status: 'awaiting_approval' } });
      await expect(createRunWithinCap(db(), planner, input, 2)).rejects.toBeInstanceOf(TooManyRunsError);
      const res = await request(app).post('/api/v1/agent_runs').set(atlas).send({ goal: 'Create a commercial report from approved sources.', intent, source_version_ids: PASSING }).expect(409);
      expect(res.body.error.code).toBe('too_many_active_runs');
      // Nobody decides: past the approval window the paused runs lapse and stop counting.
      await db().$executeRaw`UPDATE "AgentRun" SET "updatedAt" = now() - interval '25 hours' WHERE id IN (${a.id}, ${b.id})`;
      const c = await createRunWithinCap(db(), planner, input, 2);
      await recoverStaleWork(db());
      expect((await db().agentRun.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('failed');
      // And a run can be stopped by hand.
      await cancelRun(db(), c.id, 'user_atlas');
      expect((await db().agentRun.findUniqueOrThrow({ where: { id: c.id } })).summary).toBe('Stopped by you.');
      await expect(cancelRun(db(), c.id, 'user_atlas')).rejects.toBeInstanceOf(AgentStateError);
      await db().agentRun.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { status: 'failed' } });
    });

    it('is fair: one endpoint can’t take a whole delivery pass', async () => {
      const slow = await createEndpoint(['report.withdrawn', 'report.relisted'], '/slow');
      const other = await createEndpoint(['report.withdrawn'], '/other-one');
      for (let i = 0; i < 3; i++) {
        await withdraw();
        await relist();
      }
      // slow: 6 pending, other: 3 pending. One pass of 4: at most 2 per endpoint.
      expect(await deliverDue(deps, { batchSize: 4, maxBatches: 1 })).toBe(4);
      const sent = (id: string) => db().webhookDelivery.count({ where: { endpointId: id, status: 'succeeded' } });
      expect(await sent(slow.id)).toBe(2);
      expect(await sent(other.id)).toBe(2);
    });

    it('keeps counting attempts up across manual retries, and won’t re-send a delivered one by mistake', async () => {
      const ep = await createEndpoint(['report.withdrawn']);
      receiver.status(500);
      await withdraw();
      await deliverDue(deps);
      const [d] = await deliveries(ep.id);
      await db().webhookDelivery.update({ where: { id: d!.id }, data: { status: 'failed', nextAttemptAt: null } });
      receiver.status(200);
      await request(app).post(`/api/v1/webhook_deliveries/${d!.id}/retry`).set(atlas).expect(202);
      await deliverDue(deps);
      expect(receiver.received.map((r) => r.headers['tracepay-delivery-attempt'])).toEqual(['1', '2']);
      expect(await db().webhookDelivery.findUniqueOrThrow({ where: { id: d!.id } })).toMatchObject({ status: 'succeeded', attempts: 2, scheduleBase: 1 });
      expect((await request(app).post(`/api/v1/webhook_deliveries/${d!.id}/retry`).set(atlas).expect(409)).body.error.message).toMatch(/resend/);
    });

    it('lets in-flight deliveries finish on shutdown and claims nothing new', async () => {
      await createEndpoint(['report.withdrawn']);
      let release: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => receiver.respond((_req, res) => {
        release = () => res.writeHead(200).end('ok');
        resolve();
      }));
      const dispatcher = new WebhookDispatcher(() => deps, { pollMs: 50, eventWindowMs: 5_000 });
      setOutboxListener(() => dispatcher.kick('event'));
      try {
        await withdraw();
        await arrived;
        const stopping = dispatcher.stop();
        await relist(); // a new event while stopping: not claimed by this worker
        release();
        await stopping;
        const recorded = await db().webhookDelivery.findMany({ where: { event: { type: 'report.withdrawn' }, endpoint: { ownerId: 'user_atlas' } }, orderBy: { createdAt: 'desc' }, take: 1 });
        expect(recorded[0]!.status).toBe('succeeded');
      } finally {
        setOutboxListener(null);
      }
    });

    it('caps concurrent agent runs exactly, even when started at the same moment', async () => {
      await db().agentRun.updateMany({ where: { publisherId: 'user_atlas', status: 'running' }, data: { status: 'failed' } });
      const planner = { name: 'stub', model: 'none' } as unknown as AgentPlanner;
      const input = { publisherId: 'user_atlas', goal: 'Concurrency test goal.', intent: {} as never, selection: ['x'], policy: { autoReplace: false } };
      // A race: repeat it so a lucky interleaving can't hide a bug.
      for (let round = 0; round < 5; round++) {
        const results = await Promise.allSettled([1, 2, 3, 4].map(() => createRunWithinCap(db(), planner, input, 2)));
        expect(results.filter((r) => r.status === 'fulfilled'), `round ${round}`).toHaveLength(2);
        expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof TooManyRunsError)).toHaveLength(2);
        expect(await db().agentRun.count({ where: { publisherId: 'user_atlas', status: 'running' } })).toBe(2);
        await db().agentRun.updateMany({ where: { publisherId: 'user_atlas', status: 'running' }, data: { status: 'failed' } });
      }
    });

    it('only signed-in requests count as activity (scanners don’t wake the database)', async () => {
      let kicks = 0;
      const tracked = createApp({ ...testDeps(paypal), onActivity: () => kicks++ });
      await request(tracked).get('/api/health');
      await request(tracked).get('/api/artifacts');
      await request(tracked).get('/nothing-here');
      expect(kicks).toBe(0);
      await request(tracked).get('/api/v1/account').set(atlas).expect(200);
      expect(kicks).toBe(1);
    });
  });
});
