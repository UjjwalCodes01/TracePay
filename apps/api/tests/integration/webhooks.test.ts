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
  deliverDue, DISABLE_AFTER_MS, MAX_ATTEMPTS, MAX_ENDPOINTS_PER_ACCOUNT, pruneWebhookData, RETRY_DELAYS_MS, WebhookDispatcher,
} from '../../src/modules/platform/webhooks';
import { FakePayPal } from '../fake-paypal';
import { testApp, testWebhookBox, testWebhookDeps } from '../test-app';
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

    it('never sends the same delivery twice, even with concurrent workers', async () => {
      const ep = await createEndpoint(['report.withdrawn', 'report.relisted']);
      receiver.respond((_req, res) => setTimeout(() => res.writeHead(200).end('ok'), 100));
      await withdraw();
      await relist();
      await withdraw();
      await relist();
      await Promise.all([deliverDue(deps), deliverDue(deps), deliverDue(deps)]);
      const ds = await deliveries(ep.id);
      expect(ds).toHaveLength(4);
      expect(ds.every((d) => d.status === 'succeeded' && d.attempts === 1)).toBe(true);
      expect(receiver.received).toHaveLength(4);
      expect(new Set(receiver.received.map((r) => r.headers['tracepay-delivery-id'])).size).toBe(4);
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
      expect(failed.body).toMatchObject({ status: 'pending', last_status_code: 500 });
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
      const pending = await request(app).get(`/api/v1/webhook_endpoints/${ep.id}/deliveries?status=pending`).set(atlas).expect(200);
      expect(pending.body.data).toHaveLength(1);
      expect(pending.body.data[0].history[0]).toMatchObject({ attempt: 1, status_code: 500 });
    });
  });

  describe('background delivery and housekeeping', () => {
    it('the dispatcher delivers on its own once kicked', async () => {
      await createEndpoint(['report.withdrawn']);
      const dispatcher = new WebhookDispatcher(deps, { pollMs: 50, activeWindowMs: 2_000 });
      setOutboxListener(() => dispatcher.kick());
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
      await db().idempotencyKey.create({ data: { userId: 'user_atlas', key: 'ancient', requestHash: 'x', createdAt: old } });
      const result = await pruneWebhookData(db());
      expect(result.idempotencyKeys).toBeGreaterThanOrEqual(1);
      // The event still waiting for its retries survives.
      expect(await db().webhookDelivery.count({ where: { endpointId: ep.id, status: 'pending' } })).toBe(1);
      expect(await db().outboundEvent.count({ where: { deliveries: { none: { status: 'pending' } } } })).toBe(0);
      await relist();
    });

    it('“Reset demo” clears the demo publisher’s endpoints and events', async () => {
      await createEndpoint();
      await softResetDemo(db());
      expect(await db().webhookEndpoint.count({ where: { ownerId: 'user_atlas' } })).toBe(0);
      expect(await db().outboundEvent.count({ where: { ownerId: 'user_atlas' } })).toBe(0);
    });
  });
});
