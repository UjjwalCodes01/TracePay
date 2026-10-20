import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { logger } from '../../http/logger';
import { EVENT_TYPE_NAMES, newDeliveryId, PING_EVENT, recordPublicEvent } from './events';
import { checkWebhookUrl, safePost, type Lookup, type UrlPolicy } from './safe-http';
import { generateWebhookSecret, SecretBox, signatureHeader, SIGNATURE_HEADER } from './webhook-crypto';

export class WebhookError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'invalid' | 'limit' | 'conflict' | 'state') {
    super(message);
    this.name = 'WebhookError';
  }
}

export interface WebhookDeps {
  db: Db;
  box: SecretBox;
  policy: UrlPolicy;
  timeoutMs?: number;
  /** Test hook: custom DNS resolution (the SSRF guard still applies to its answers). */
  lookup?: Lookup;
}

export const MAX_ENDPOINTS_PER_ACCOUNT = 10;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 2_048;
/** Delays before attempts 2…8: about 1.5 days of retries in total. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000, 10 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** An endpoint failing without a single success for this long (and at least this many times) is disabled. */
export const DISABLE_AFTER_MS = 3 * 24 * 3_600_000;
export const DISABLE_AFTER_FAILURES = 5;
const LEASE_MS = 2 * 60_000;
const HISTORY_LIMIT = 20;

// ---- endpoint management ------------------------------------------------------------

function normaliseEvents(events: string[]): string[] {
  const unique = [...new Set(events.map((e) => e.trim()).filter(Boolean))];
  if (unique.length === 0) throw new WebhookError('Choose at least one event type, or "*" for all events.', 'invalid');
  if (unique.includes('*')) {
    if (unique.length > 1) throw new WebhookError('"*" already includes every event; send it alone.', 'invalid');
    return ['*'];
  }
  const unknown = unique.filter((e) => !EVENT_TYPE_NAMES.has(e));
  if (unknown.length) throw new WebhookError(`Unknown event type: ${unknown.join(', ')}.`, 'invalid');
  return unique.sort();
}

function validUrl(url: string, policy: UrlPolicy): string {
  if (url.length > 2_048) throw new WebhookError('The URL is too long (2048 characters at most).', 'invalid');
  const checked = checkWebhookUrl(url, policy);
  if (!checked.ok) throw new WebhookError(checked.reason, 'invalid');
  return checked.url.toString();
}

const endpointSelect = {
  id: true, url: true, description: true, enabledEvents: true, status: true, disabledReason: true,
  consecutiveFailures: true, failingSince: true, previousSecretExpires: true, createdAt: true, updatedAt: true,
} as const;
export type EndpointRow = Prisma.WebhookEndpointGetPayload<{ select: typeof endpointSelect }>;

export async function createEndpoint(
  deps: WebhookDeps,
  ownerId: string,
  input: { url: string; description?: string | null; enabledEvents: string[] },
): Promise<{ endpoint: EndpointRow; secret: string }> {
  const url = validUrl(input.url, deps.policy);
  const enabledEvents = normaliseEvents(input.enabledEvents);
  const secret = generateWebhookSecret();
  return deps.db.$transaction(async (tx) => {
    // Serialise per owner so the limit and the duplicate check can't race.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`webhook-endpoints:${ownerId}`}))`;
    const existing = await tx.webhookEndpoint.findMany({ where: { ownerId }, select: { url: true } });
    if (existing.length >= MAX_ENDPOINTS_PER_ACCOUNT) throw new WebhookError(`You can have at most ${MAX_ENDPOINTS_PER_ACCOUNT} webhook endpoints.`, 'limit');
    if (existing.some((e) => e.url === url)) throw new WebhookError('An endpoint with this URL already exists.', 'conflict');
    const endpoint = await tx.webhookEndpoint.create({
      data: { ownerId, url, description: input.description?.trim() || null, enabledEvents, secretEnc: deps.box.seal(secret) },
      select: endpointSelect,
    });
    return { endpoint, secret };
  });
}

export async function getEndpoint(db: Db, ownerId: string, id: string): Promise<EndpointRow> {
  const endpoint = await db.webhookEndpoint.findFirst({ where: { id, ownerId }, select: endpointSelect });
  if (!endpoint) throw new WebhookError('Webhook endpoint not found.', 'not_found');
  return endpoint;
}

export async function updateEndpoint(
  deps: WebhookDeps,
  ownerId: string,
  id: string,
  patch: { url?: string; description?: string | null; enabledEvents?: string[]; status?: 'enabled' | 'disabled' },
): Promise<EndpointRow> {
  const current = await getEndpoint(deps.db, ownerId, id);
  const data: Prisma.WebhookEndpointUpdateInput = {};
  if (patch.url !== undefined) {
    const url = validUrl(patch.url, deps.policy);
    if (url !== current.url && (await deps.db.webhookEndpoint.count({ where: { ownerId, url, id: { not: id } } }))) {
      throw new WebhookError('An endpoint with this URL already exists.', 'conflict');
    }
    data.url = url;
  }
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;
  if (patch.enabledEvents !== undefined) data.enabledEvents = normaliseEvents(patch.enabledEvents);
  if (patch.status === 'enabled' && current.status !== 'enabled') {
    // A fresh start: the failure streak that disabled it no longer counts.
    Object.assign(data, { status: 'enabled', disabledReason: null, consecutiveFailures: 0, failingSince: null });
  } else if (patch.status === 'disabled' && current.status !== 'disabled') {
    Object.assign(data, { status: 'disabled', disabledReason: 'Disabled by you.' });
  }
  return deps.db.webhookEndpoint.update({ where: { id }, data, select: endpointSelect });
}

export async function deleteEndpoint(db: Db, ownerId: string, id: string): Promise<void> {
  const result = await db.webhookEndpoint.deleteMany({ where: { id, ownerId } });
  if (result.count === 0) throw new WebhookError('Webhook endpoint not found.', 'not_found');
}

/**
 * New signing secret. The previous one keeps signing alongside it for
 * `previousValidHours` (0 = stop immediately), so receivers can switch over.
 */
export async function rotateSecret(deps: WebhookDeps, ownerId: string, id: string, previousValidHours = 24): Promise<{ endpoint: EndpointRow; secret: string }> {
  if (!Number.isInteger(previousValidHours) || previousValidHours < 0 || previousValidHours > 168) {
    throw new WebhookError('The old secret can stay valid for 0 to 168 hours.', 'invalid');
  }
  const row = await deps.db.webhookEndpoint.findFirst({ where: { id, ownerId }, select: { secretEnc: true } });
  if (!row) throw new WebhookError('Webhook endpoint not found.', 'not_found');
  const secret = generateWebhookSecret();
  const endpoint = await deps.db.webhookEndpoint.update({
    where: { id },
    data: {
      secretEnc: deps.box.seal(secret),
      previousSecretEnc: previousValidHours > 0 ? row.secretEnc : null,
      previousSecretExpires: previousValidHours > 0 ? new Date(Date.now() + previousValidHours * 3_600_000) : null,
    },
    select: endpointSelect,
  });
  return { endpoint, secret };
}

// ---- deliveries ---------------------------------------------------------------------

export interface EventRow {
  id: string;
  type: string;
  data: Prisma.JsonValue;
  createdAt: Date;
}

/** The JSON body of a delivery, and of `GET /events/{id}`. */
export function eventEnvelope(e: EventRow) {
  return { id: e.id, object: 'event' as const, type: e.type, api_version: 'v1' as const, created: e.createdAt.toISOString(), sandbox: true, data: (e.data ?? {}) as Record<string, unknown> };
}

export const deliverySelect = {
  id: true, eventId: true, endpointId: true, status: true, attempts: true, nextAttemptAt: true, lastAttemptAt: true,
  lastStatusCode: true, lastError: true, history: true, createdAt: true, updatedAt: true, event: { select: { type: true } },
} as const;
export type DeliveryRow = Prisma.WebhookDeliveryGetPayload<{ select: typeof deliverySelect }>;

/** Claims due deliveries with a lease. SKIP LOCKED: concurrent workers never claim the same one. */
async function claimDue(db: Db, now: Date, limit: number, onlyId?: string): Promise<string[]> {
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = onlyId
    ? await db.$queryRaw<{ id: string }[]>`
        UPDATE "WebhookDelivery" SET "lockedUntil" = ${lease}, "updatedAt" = ${now}
        WHERE id IN (SELECT id FROM "WebhookDelivery"
                     WHERE id = ${onlyId} AND status = 'pending' AND ("lockedUntil" IS NULL OR "lockedUntil" < ${now})
                     FOR UPDATE SKIP LOCKED)
        RETURNING id`
    : await db.$queryRaw<{ id: string }[]>`
        UPDATE "WebhookDelivery" SET "lockedUntil" = ${lease}, "updatedAt" = ${now}
        WHERE id IN (SELECT id FROM "WebhookDelivery"
                     WHERE status = 'pending' AND "nextAttemptAt" <= ${now} AND ("lockedUntil" IS NULL OR "lockedUntil" < ${now})
                     ORDER BY "nextAttemptAt" ASC LIMIT ${limit}
                     FOR UPDATE SKIP LOCKED)
        RETURNING id`;
  return rows.map((r) => r.id);
}

function retryDelay(attemptsMade: number): number | null {
  const base = RETRY_DELAYS_MS[attemptsMade - 1];
  if (base === undefined) return null;
  // ±10% jitter so a recovering receiver isn't hit by every retry at once.
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

/** Sends one claimed delivery and records the outcome. */
async function attempt(deps: WebhookDeps, deliveryId: string, now: Date): Promise<void> {
  const delivery = await deps.db.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { event: true, endpoint: true },
  });
  if (!delivery || delivery.status !== 'pending') return;
  const { endpoint } = delivery;

  if (endpoint.status !== 'enabled') {
    await deps.db.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'skipped', lockedUntil: null, nextAttemptAt: null, lastError: 'Not sent: the endpoint is disabled.' },
    });
    return;
  }

  const secrets = [deps.box.open(endpoint.secretEnc)];
  if (endpoint.previousSecretEnc && endpoint.previousSecretExpires && endpoint.previousSecretExpires > now) secrets.push(deps.box.open(endpoint.previousSecretEnc));
  const body = JSON.stringify(eventEnvelope(delivery.event));
  const timestamp = Math.floor(now.getTime() / 1000);
  const attemptNo = delivery.attempts + 1;

  const result = await safePost(
    endpoint.url,
    body,
    {
      'user-agent': 'TracePay-Webhooks/1.0 (+https://github.com/UjjwalCodes01/TracePay)',
      [SIGNATURE_HEADER.toLowerCase()]: signatureHeader(secrets, timestamp, body),
      'tracepay-event-id': delivery.event.id,
      'tracepay-event-type': delivery.event.type,
      'tracepay-delivery-id': delivery.id,
      'tracepay-delivery-attempt': String(attemptNo),
    },
    { ...deps.policy, timeoutMs: deps.timeoutMs ?? DELIVERY_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES, lookup: deps.lookup },
  );

  const ok = result.statusCode !== null && result.statusCode >= 200 && result.statusCode < 300;
  const gone = result.statusCode === 410;
  const error = ok
    ? null
    : (result.error ?? (result.statusCode !== null && result.statusCode >= 300 && result.statusCode < 400 ? `HTTP ${result.statusCode}: redirects are not followed` : `HTTP ${result.statusCode}`));
  const delay = ok || gone ? null : retryDelay(attemptNo);
  const status = ok ? 'succeeded' : gone || delay === null ? 'failed' : 'pending';
  const history = [
    ...((delivery.history as Prisma.JsonArray) ?? []),
    { at: now.toISOString(), attempt: attemptNo, status_code: result.statusCode, error, duration_ms: result.durationMs },
  ].slice(-HISTORY_LIMIT);

  await deps.db.$transaction(async (tx) => {
    await tx.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status,
        attempts: attemptNo,
        lastAttemptAt: now,
        lastStatusCode: result.statusCode,
        lastError: error ? `${error}${result.body ? ` — ${result.body.slice(0, 300)}` : ''}` : null,
        nextAttemptAt: status === 'pending' ? new Date(now.getTime() + delay!) : null,
        lockedUntil: null,
        history: history as Prisma.InputJsonValue,
      },
    });
    if (ok) {
      await tx.webhookEndpoint.updateMany({ where: { id: endpoint.id, consecutiveFailures: { gt: 0 } }, data: { consecutiveFailures: 0, failingSince: null } });
      return;
    }
    const failingSince = endpoint.failingSince ?? now;
    const failures = endpoint.consecutiveFailures + 1;
    const disable = gone
      ? 'Disabled: the receiver answered 410 Gone.'
      : failures >= DISABLE_AFTER_FAILURES && now.getTime() - failingSince.getTime() >= DISABLE_AFTER_MS
        ? 'Disabled automatically: every delivery failed for 3 days.'
        : null;
    await tx.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: failures, failingSince, ...(disable ? { status: 'disabled', disabledReason: disable } : {}) },
    });
    if (disable) logger.warn({ endpointId: endpoint.id, reason: disable }, 'webhook endpoint disabled');
  });
}

/** Delivers everything due, in batches. Returns how many deliveries were attempted. */
export async function deliverDue(deps: WebhookDeps, opts: { now?: () => Date; batchSize?: number; maxBatches?: number } = {}): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 10;
  let total = 0;
  for (let batch = 0; batch < (opts.maxBatches ?? 20); batch++) {
    const ids = await claimDue(deps.db, now(), batchSize);
    if (ids.length === 0) break;
    total += ids.length;
    await Promise.all(
      ids.map((id) =>
        attempt(deps, id, now()).catch(async (err) => {
          logger.error({ err, deliveryId: id }, 'webhook delivery crashed');
          // Release the lease; the regular schedule retries it.
          await deps.db.webhookDelivery.updateMany({ where: { id, status: 'pending' }, data: { lockedUntil: null } }).catch(() => undefined);
        }),
      ),
    );
    if (ids.length < batchSize) break;
  }
  return total;
}

/** When the next pending delivery is due (null if none). */
export async function nextDueAt(db: Db): Promise<Date | null> {
  const next = await db.webhookDelivery.findFirst({ where: { status: 'pending' }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true, lockedUntil: true } });
  if (!next) return null;
  const due = next.nextAttemptAt ?? new Date();
  return next.lockedUntil && next.lockedUntil > due ? next.lockedUntil : due;
}

/** Sends a `ping` event to one endpoint right away and returns the delivery's outcome. */
export async function sendTestEvent(deps: WebhookDeps, ownerId: string, endpointId: string): Promise<DeliveryRow> {
  const endpoint = await getEndpoint(deps.db, ownerId, endpointId);
  if (endpoint.status !== 'enabled') throw new WebhookError('Enable the endpoint before sending a test event.', 'state');
  const now = new Date();
  const { eventId } = await deps.db.$transaction((tx) =>
    recordPublicEvent(tx, {
      auditSeq: null,
      ownerId,
      type: PING_EVENT.type,
      data: { object_type: 'webhook_endpoint', object_id: endpointId, message: 'This is a test event from TracePay.' },
      createdAt: now,
      onlyEndpointId: endpointId,
    }),
  );
  const delivery = await deps.db.webhookDelivery.findUniqueOrThrow({ where: { eventId_endpointId: { eventId, endpointId } }, select: { id: true } });
  const claimed = await claimDue(deps.db, now, 1, delivery.id);
  if (claimed.length) await attempt(deps, delivery.id, now);
  return deps.db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id }, select: deliverySelect });
}

/** Queues a delivery again with a fresh retry schedule (keeps its history). */
export async function retryDelivery(db: Db, ownerId: string, deliveryId: string): Promise<DeliveryRow> {
  const delivery = await db.webhookDelivery.findFirst({ where: { id: deliveryId, endpoint: { ownerId } }, select: { status: true, endpoint: { select: { status: true } } } });
  if (!delivery) throw new WebhookError('Delivery not found.', 'not_found');
  if (delivery.status === 'pending') throw new WebhookError('This delivery is already queued.', 'state');
  if (delivery.endpoint.status !== 'enabled') throw new WebhookError('Enable the endpoint before retrying its deliveries.', 'state');
  await db.webhookDelivery.updateMany({ where: { id: deliveryId, status: { not: 'pending' } }, data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lockedUntil: null } });
  return db.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: deliverySelect });
}

/** Re-sends an existing event to one endpoint (e.g. one that was down or created later). */
export async function resendEvent(db: Db, ownerId: string, eventId: string, endpointId: string): Promise<DeliveryRow> {
  const [event, endpoint] = await Promise.all([
    db.outboundEvent.findFirst({ where: { id: eventId, ownerId }, select: { id: true } }),
    db.webhookEndpoint.findFirst({ where: { id: endpointId, ownerId }, select: { id: true, status: true } }),
  ]);
  if (!event) throw new WebhookError('Event not found.', 'not_found');
  if (!endpoint) throw new WebhookError('Webhook endpoint not found.', 'not_found');
  if (endpoint.status !== 'enabled') throw new WebhookError('Enable the endpoint before sending events to it.', 'state');
  const existing = await db.webhookDelivery.findUnique({ where: { eventId_endpointId: { eventId, endpointId } }, select: { id: true } });
  if (existing) return retryDelivery(db, ownerId, existing.id).catch((err) => {
    if (err instanceof WebhookError && err.code === 'state') return db.webhookDelivery.findUniqueOrThrow({ where: { id: existing.id }, select: deliverySelect });
    throw err;
  });
  return db.webhookDelivery.create({ data: { id: newDeliveryId(), eventId, endpointId, nextAttemptAt: new Date() }, select: deliverySelect });
}

// ---- housekeeping -------------------------------------------------------------------

export const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;

/** Prunes old events (and their deliveries), expired idempotency records and expired rotated secrets. */
export async function pruneWebhookData(db: Db, now = new Date()): Promise<{ events: number; idempotencyKeys: number }> {
  const events = await db.outboundEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - EVENT_RETENTION_MS) }, deliveries: { none: { status: 'pending' } } } });
  const idempotencyKeys = await db.idempotencyKey.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * 3_600_000) } } });
  await db.webhookEndpoint.updateMany({ where: { previousSecretExpires: { lt: now } }, data: { previousSecretEnc: null, previousSecretExpires: null } });
  return { events: events.count, idempotencyKeys: idempotencyKeys.count };
}

/**
 * Runs deliveries in the background without keeping a serverless database awake:
 * it polls only while the API is active (kicked by requests and new events) and
 * otherwise sleeps until the next scheduled retry. Safe to run on several
 * instances at once (claims use SKIP LOCKED and leases).
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private dueAt = Infinity;
  private running = false;
  private lastKick = 0;
  private stopped = false;

  constructor(
    private readonly deps: WebhookDeps,
    private readonly opts: { pollMs?: number; activeWindowMs?: number } = {},
  ) {}

  /** Something happened (a request, a new event): deliver soon and keep polling for a while. */
  kick(): void {
    this.lastKick = Date.now();
    this.schedule(500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    const at = Date.now() + Math.max(0, delayMs);
    if (this.timer && at >= this.dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => void this.tick(), Math.min(Math.max(0, delayMs), 2_147_000_000));
    this.timer.unref();
  }

  private async tick() {
    this.timer = null;
    this.dueAt = Infinity;
    if (this.running) return this.schedule(1_000);
    this.running = true;
    try {
      await deliverDue(this.deps);
      const active = Date.now() - this.lastKick < (this.opts.activeWindowMs ?? 60_000);
      if (active) {
        this.schedule(this.opts.pollMs ?? 3_000);
      } else {
        const next = await nextDueAt(this.deps.db);
        if (next) this.schedule(next.getTime() - Date.now());
      }
    } catch (err) {
      logger.error({ err }, 'webhook dispatcher tick failed');
      this.schedule(30_000);
    } finally {
      this.running = false;
    }
  }
}

