import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { logger } from '../../http/logger';
import { EVENT_TYPE_NAMES, newDeliveryId, PING_EVENT, recordPublicEvent } from './events';
import type { EventRow } from './event-row';
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
/** Delays before attempts 2…8: about 27 hours of retries in total. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000, 10 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** An endpoint failing without a single success for this long (and at least this many times) is disabled. */
export const DISABLE_AFTER_MS = 3 * 24 * 3_600_000;
export const DISABLE_AFTER_FAILURES = 5;
export const LEASE_MS = 2 * 60_000;
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
  // Validate before taking the lock.
  const url = patch.url !== undefined ? validUrl(patch.url, deps.policy) : undefined;
  const enabledEvents = patch.enabledEvents !== undefined ? normaliseEvents(patch.enabledEvents) : undefined;
  return deps.db.$transaction(async (tx) => {
    // Same per-owner lock as createEndpoint: the duplicate-URL check can't race.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`webhook-endpoints:${ownerId}`}))`;
    const current = await tx.webhookEndpoint.findFirst({ where: { id, ownerId }, select: { url: true, status: true } });
    if (!current) throw new WebhookError('Webhook endpoint not found.', 'not_found');
    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (url !== undefined) {
      if (url !== current.url && (await tx.webhookEndpoint.count({ where: { ownerId, url, id: { not: id } } }))) {
        throw new WebhookError('An endpoint with this URL already exists.', 'conflict');
      }
      data.url = url;
    }
    if (patch.description !== undefined) data.description = patch.description?.trim() || null;
    if (enabledEvents !== undefined) data.enabledEvents = enabledEvents;
    if (patch.status === 'enabled' && current.status !== 'enabled') {
      // A fresh start: the failure streak that disabled it no longer counts.
      Object.assign(data, { status: 'enabled', disabledReason: null, consecutiveFailures: 0, failingSince: null });
    } else if (patch.status === 'disabled' && current.status !== 'disabled') {
      Object.assign(data, { status: 'disabled', disabledReason: 'Disabled by you.' });
    }
    return tx.webhookEndpoint.update({ where: { id }, data, select: endpointSelect });
  });
}

export async function deleteEndpoint(db: Db, ownerId: string, id: string): Promise<void> {
  const result = await db.webhookEndpoint.deleteMany({ where: { id, ownerId } });
  if (result.count === 0) throw new WebhookError('Webhook endpoint not found.', 'not_found');
}

/**
 * New signing secret. The previous one keeps signing alongside it for
 * `previousValidHours` (0 = stop immediately), so receivers can switch over.
 * One atomic UPDATE: concurrent rotations can't hand out a secret that never signs.
 */
export async function rotateSecret(deps: WebhookDeps, ownerId: string, id: string, previousValidHours = 24): Promise<{ endpoint: EndpointRow; secret: string }> {
  if (!Number.isInteger(previousValidHours) || previousValidHours < 0 || previousValidHours > 168) {
    throw new WebhookError('The old secret can stay valid for 0 to 168 hours.', 'invalid');
  }
  const secret = generateWebhookSecret();
  const sealed = deps.box.seal(secret);
  const keepOld = previousValidHours > 0;
  const expires = keepOld ? new Date(Date.now() + previousValidHours * 3_600_000) : null;
  const updated = await deps.db.$executeRaw`
    UPDATE "WebhookEndpoint"
    SET "previousSecretEnc" = CASE WHEN ${keepOld} THEN "secretEnc" ELSE NULL END,
        "previousSecretExpires" = ${expires},
        "secretEnc" = ${sealed},
        "updatedAt" = now()
    WHERE id = ${id} AND "ownerId" = ${ownerId}`;
  if (updated === 0) throw new WebhookError('Webhook endpoint not found.', 'not_found');
  return { endpoint: await getEndpoint(deps.db, ownerId, id), secret };
}

// ---- deliveries ---------------------------------------------------------------------

/** The JSON body of a delivery, and of `GET /events/{id}`. */
export function eventEnvelope(e: EventRow) {
  return { id: e.id, object: 'event' as const, type: e.type, api_version: 'v1' as const, created: e.createdAt.toISOString(), sandbox: true, data: (e.data ?? {}) as Record<string, unknown> };
}

export const deliverySelect = {
  id: true, eventId: true, endpointId: true, status: true, attempts: true, nextAttemptAt: true, lastAttemptAt: true,
  lastStatusCode: true, lastError: true, history: true, createdAt: true, updatedAt: true, event: { select: { type: true } },
} as const;
export type DeliveryRow = Prisma.WebhookDeliveryGetPayload<{ select: typeof deliverySelect }>;

interface Claim {
  id: string;
  /** The lease this worker holds: results are only written while it still holds it. */
  lease: Date;
}

/** At most this many deliveries per endpoint in one pass: a slow or dead endpoint can't hold up everyone else's. */
const PER_ENDPOINT_PER_PASS = 2;

/**
 * Claims due deliveries with a lease. SKIP LOCKED: concurrent workers never claim
 * the same one. Fair: per endpoint, only its oldest few are taken in a pass.
 */
async function claimDue(db: Db, now: Date, limit: number): Promise<Claim[]> {
  const lease = new Date(now.getTime() + LEASE_MS);
  // The availability conditions are repeated on the row-locking SELECT (and the UPDATE):
  // Postgres re-checks only the locking query's own WHERE against the latest row
  // version, so a row another worker just leased must fail it there — the inner
  // (non-locking) ranking subquery may have seen it before that lease committed.
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "WebhookDelivery" SET "lockedUntil" = ${lease}, "updatedAt" = ${now}
    WHERE status = 'pending' AND ("lockedUntil" IS NULL OR "lockedUntil" < ${now})
      AND id IN (
      SELECT id FROM "WebhookDelivery"
      WHERE status = 'pending' AND "nextAttemptAt" <= ${now} AND ("lockedUntil" IS NULL OR "lockedUntil" < ${now})
        AND id IN (
        SELECT id FROM (
          SELECT id, "nextAttemptAt", row_number() OVER (PARTITION BY "endpointId" ORDER BY "nextAttemptAt", id) AS rn
          FROM "WebhookDelivery"
          WHERE status = 'pending' AND "nextAttemptAt" <= ${now} AND ("lockedUntil" IS NULL OR "lockedUntil" < ${now})
        ) ranked
        WHERE rn <= ${PER_ENDPOINT_PER_PASS}
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
      )
      FOR UPDATE SKIP LOCKED)
    RETURNING id`;
  return rows.map((r) => ({ id: r.id, lease }));
}

function retryDelay(attemptsMade: number): number | null {
  const base = RETRY_DELAYS_MS[attemptsMade - 1];
  if (base === undefined) return null;
  // ±10% jitter so a recovering receiver isn't hit by every retry at once.
  return Math.round(base * (0.9 + Math.random() * 0.2));
}

/** Receiver-controlled text is stored: strip NUL and other control characters Postgres (or a UI) chokes on. */
function clean(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

type HistoryEntry = { at: string; attempt: number; status_code: number | null; error: string | null; duration_ms: number };

/**
 * Sends one claimed delivery and records the outcome — but only while this
 * worker still holds the lease, so a stalled worker can't overwrite the result
 * of the one that took over.
 *
 * Pings (test events) are sent once: they report how the endpoint answers right
 * now and never count toward its failure streak or disable it.
 */
async function attempt(deps: WebhookDeps, claim: Claim, now: Date): Promise<void> {
  const delivery = await deps.db.webhookDelivery.findUnique({ where: { id: claim.id }, include: { event: true, endpoint: true } });
  if (!delivery || delivery.status !== 'pending') return;
  const { endpoint } = delivery;
  const holdsLease = { id: claim.id, status: 'pending' as const, lockedUntil: claim.lease };

  if (endpoint.status !== 'enabled') {
    await deps.db.webhookDelivery.updateMany({
      where: holdsLease,
      data: { status: 'skipped', lockedUntil: null, nextAttemptAt: null, lastError: 'Not sent: the endpoint is disabled.' },
    });
    return;
  }

  const secrets = [deps.box.open(endpoint.secretEnc)];
  if (endpoint.previousSecretEnc && endpoint.previousSecretExpires && endpoint.previousSecretExpires > now) secrets.push(deps.box.open(endpoint.previousSecretEnc));
  const body = JSON.stringify(eventEnvelope(delivery.event));
  const timestamp = Math.floor(now.getTime() / 1000);
  const attemptNo = delivery.attempts + 1;
  const cycleAttempt = attemptNo - delivery.scheduleBase;
  const isPing = delivery.event.type === PING_EVENT.type;

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
  const reason = ok
    ? null
    : (result.error ?? (result.statusCode !== null && result.statusCode >= 300 && result.statusCode < 400 ? `HTTP ${result.statusCode}: redirects are not followed` : `HTTP ${result.statusCode}`));
  const error = reason === null ? null : clean(reason, 500);
  const responseSnippet = clean(result.body, 300);
  const delay = ok || gone || isPing ? null : retryDelay(cycleAttempt);
  const status = ok ? 'succeeded' : delay === null ? 'failed' : 'pending';
  const history: HistoryEntry[] = [
    ...(((delivery.history as unknown as HistoryEntry[]) ?? []) as HistoryEntry[]),
    { at: now.toISOString(), attempt: attemptNo, status_code: result.statusCode, error, duration_ms: result.durationMs },
  ].slice(-HISTORY_LIMIT);

  await deps.db.$transaction(async (tx) => {
    const written = await tx.webhookDelivery.updateMany({
      where: holdsLease,
      data: {
        status,
        attempts: attemptNo,
        lastAttemptAt: now,
        lastStatusCode: result.statusCode,
        lastError: error ? `${error}${responseSnippet ? ` — ${responseSnippet}` : ''}` : null,
        nextAttemptAt: status === 'pending' ? new Date(now.getTime() + delay!) : null,
        lockedUntil: null,
        history: history as unknown as Prisma.InputJsonValue,
      },
    });
    if (written.count === 0) {
      logger.warn({ deliveryId: claim.id }, 'webhook delivery lease lost before its result was recorded');
      return;
    }
    if (isPing) return;
    if (ok) {
      await tx.webhookEndpoint.updateMany({ where: { id: endpoint.id, consecutiveFailures: { gt: 0 } }, data: { consecutiveFailures: 0, failingSince: null } });
      return;
    }
    // Atomic: concurrent failures each count, and a streak reset (re-enable or a
    // success) that landed meanwhile isn't overwritten with a stale snapshot.
    const [streak] = await tx.$queryRaw<{ consecutiveFailures: number; failingSince: Date }[]>`
      UPDATE "WebhookEndpoint"
      SET "consecutiveFailures" = "consecutiveFailures" + 1, "failingSince" = COALESCE("failingSince", ${now}), "updatedAt" = now()
      WHERE id = ${endpoint.id} AND status = 'enabled'
      RETURNING "consecutiveFailures", "failingSince"`;
    if (!streak) return;
    const disable = gone
      ? 'Disabled: the receiver answered 410 Gone.'
      : streak.consecutiveFailures >= DISABLE_AFTER_FAILURES && now.getTime() - new Date(streak.failingSince).getTime() >= DISABLE_AFTER_MS
        ? 'Disabled automatically: every delivery failed for 3 days.'
        : null;
    if (disable) {
      await tx.webhookEndpoint.updateMany({ where: { id: endpoint.id, status: 'enabled' }, data: { status: 'disabled', disabledReason: disable } });
      logger.warn({ endpointId: endpoint.id, reason: disable }, 'webhook endpoint disabled');
    }
  });
}

/**
 * An attempt that threw (an unreadable secret, a database error after sending…)
 * still counts: it is rescheduled with backoff — or failed after the last
 * attempt — so it can never be re-sent in a tight loop.
 */
async function recordCrash(db: Db, claim: Claim, now: Date, err: unknown): Promise<void> {
  const row = await db.webhookDelivery.findUnique({ where: { id: claim.id }, select: { attempts: true, scheduleBase: true, event: { select: { type: true } } } });
  if (!row) return;
  const attemptNo = row.attempts + 1;
  const delay = row.event.type === PING_EVENT.type ? null : retryDelay(attemptNo - row.scheduleBase);
  await db.webhookDelivery.updateMany({
    where: { id: claim.id, status: 'pending', lockedUntil: claim.lease },
    data: {
      attempts: attemptNo,
      lastAttemptAt: now,
      lastError: clean(`Internal error while delivering: ${(err as Error)?.message ?? 'unknown'}`, 500),
      status: delay === null ? 'failed' : 'pending',
      nextAttemptAt: delay === null ? null : new Date(now.getTime() + delay),
      lockedUntil: null,
    },
  });
}

async function attemptSafely(deps: WebhookDeps, claim: Claim, now: Date) {
  try {
    await attempt(deps, claim, now);
  } catch (err) {
    logger.error({ err, deliveryId: claim.id }, 'webhook delivery crashed');
    await recordCrash(deps.db, claim, now, err).catch((e) => logger.error({ err: e, deliveryId: claim.id }, 'could not record webhook crash'));
  }
}

/** Delivers everything due, in batches. Returns how many deliveries were attempted. */
export async function deliverDue(
  deps: WebhookDeps,
  opts: { now?: () => Date; batchSize?: number; maxBatches?: number; shouldContinue?: () => boolean } = {},
): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 20;
  let total = 0;
  for (let batch = 0; batch < (opts.maxBatches ?? 20); batch++) {
    // Shutting down: don't claim more work than can be finished.
    if (opts.shouldContinue && !opts.shouldContinue()) break;
    const claims = await claimDue(deps.db, now(), batchSize);
    if (claims.length === 0) break;
    total += claims.length;
    await Promise.all(claims.map((c) => attemptSafely(deps, c, now())));
  }
  return total;
}

/** When the next pending delivery can be sent: the earliest of unleased due times and lease expiries. */
export async function nextDueAt(db: Db, now = new Date()): Promise<Date | null> {
  const [free, leased] = await Promise.all([
    db.webhookDelivery.findFirst({
      where: { status: 'pending', OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      orderBy: { nextAttemptAt: 'asc' },
      select: { nextAttemptAt: true },
    }),
    db.webhookDelivery.findFirst({ where: { status: 'pending', lockedUntil: { gte: now } }, orderBy: { lockedUntil: 'asc' }, select: { lockedUntil: true } }),
  ]);
  const candidates = [free?.nextAttemptAt ?? (free ? now : null), leased?.lockedUntil ?? null].filter((d): d is Date => d !== null);
  return candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
}

/** Sends a `ping` event to one endpoint right away and returns the delivery's outcome. */
export async function sendTestEvent(deps: WebhookDeps, ownerId: string, endpointId: string): Promise<DeliveryRow> {
  const endpoint = await getEndpoint(deps.db, ownerId, endpointId);
  if (endpoint.status !== 'enabled') throw new WebhookError('Enable the endpoint before sending a test event.', 'state');
  const now = new Date();
  // Created already leased by this request, so no background worker can take it.
  const lease = new Date(now.getTime() + LEASE_MS);
  const { eventId } = await deps.db.$transaction((tx) =>
    recordPublicEvent(tx, {
      auditSeq: null,
      ownerId,
      type: PING_EVENT.type,
      data: { object_type: 'webhook_endpoint', object_id: endpointId, message: 'This is a test event from TracePay.' },
      createdAt: now,
      onlyEndpointId: endpointId,
      leasedUntil: lease,
    }),
  );
  const delivery = await deps.db.webhookDelivery.findUniqueOrThrow({ where: { eventId_endpointId: { eventId, endpointId } }, select: { id: true } });
  await attemptSafely(deps, { id: delivery.id, lease }, now);
  return deps.db.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id }, select: deliverySelect });
}

/**
 * Queues a delivery again with a fresh retry schedule. Attempt numbers keep
 * counting up (the history stays intact); only the backoff restarts.
 * `allowDelivered`: re-send even one the endpoint already accepted (event resend).
 */
export async function retryDelivery(db: Db, ownerId: string, deliveryId: string, opts: { allowDelivered?: boolean } = {}): Promise<DeliveryRow> {
  const delivery = await db.webhookDelivery.findFirst({ where: { id: deliveryId, endpoint: { ownerId } }, select: { status: true, attempts: true, endpoint: { select: { status: true } } } });
  if (!delivery) throw new WebhookError('Delivery not found.', 'not_found');
  if (delivery.status === 'pending') throw new WebhookError('This delivery is already queued.', 'state');
  if (delivery.status === 'succeeded' && !opts.allowDelivered) {
    throw new WebhookError('This delivery already succeeded. To send the event again, use POST /events/{id}/resend.', 'state');
  }
  if (delivery.endpoint.status !== 'enabled') throw new WebhookError('Enable the endpoint before retrying its deliveries.', 'state');
  await db.webhookDelivery.updateMany({
    where: { id: deliveryId, status: { not: 'pending' } },
    data: { status: 'pending', scheduleBase: delivery.attempts, nextAttemptAt: new Date(), lockedUntil: null },
  });
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

  const requeue = async (id: string) =>
    retryDelivery(db, ownerId, id, { allowDelivered: true }).catch(async (err) => {
      // Already queued: that is the outcome the caller wants.
      if (err instanceof WebhookError && err.code === 'state') return db.webhookDelivery.findUniqueOrThrow({ where: { id }, select: deliverySelect });
      throw err;
    });
  const existing = await db.webhookDelivery.findUnique({ where: { eventId_endpointId: { eventId, endpointId } }, select: { id: true } });
  if (existing) return requeue(existing.id);
  try {
    return await db.webhookDelivery.create({ data: { id: newDeliveryId(), eventId, endpointId, nextAttemptAt: new Date() }, select: deliverySelect });
  } catch (err) {
    // A concurrent resend created it first.
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const row = await db.webhookDelivery.findUniqueOrThrow({ where: { eventId_endpointId: { eventId, endpointId } }, select: { id: true } });
    return requeue(row.id);
  }
}

// ---- housekeeping -------------------------------------------------------------------

export const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;

/** Prunes old events (and their deliveries), expired idempotency records and expired rotated secrets. */
export async function pruneWebhookData(db: Db, now = new Date()): Promise<{ events: number; idempotencyKeys: number }> {
  const events = await db.outboundEvent.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - EVENT_RETENTION_MS) }, deliveries: { none: { status: 'pending' } } } });
  // Completed records after 24 h; unfinished ones too once their holder stopped heartbeating (crashed).
  const idempotencyKeys = await db.idempotencyKey.deleteMany({
    where: {
      createdAt: { lt: new Date(now.getTime() - 24 * 3_600_000) },
      OR: [{ statusCode: { not: null } }, { lockedAt: { lt: new Date(now.getTime() - 15 * 60_000) } }],
    },
  });
  await db.webhookEndpoint.updateMany({ where: { previousSecretExpires: { lt: now } }, data: { previousSecretEnc: null, previousSecretExpires: null } });
  return { events: events.count, idempotencyKeys: idempotencyKeys.count };
}

/**
 * Runs deliveries in the background without keeping a serverless database awake.
 *  - `kick('event')`: new events were written (maybe not committed yet): poll for
 *    a short window until they are delivered.
 *  - `kick('activity')`: the API is in use: run one pass (retries that came due
 *    while it was asleep), then sleep until the next scheduled retry.
 * Otherwise it is idle. Safe on several instances at once (SKIP LOCKED claims, leases).
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private dueAt = Infinity;
  private running = false;
  private eventWindowUntil = 0;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly deps: () => WebhookDeps,
    private readonly opts: { pollMs?: number; eventWindowMs?: number } = {},
  ) {}

  kick(reason: 'event' | 'activity' = 'activity'): void {
    if (reason === 'event') this.eventWindowUntil = Date.now() + (this.opts.eventWindowMs ?? 60_000);
    this.schedule(reason === 'event' ? 300 : 1_000);
  }

  private current: Promise<void> | null = null;

  /** Stops scheduling and claiming; resolves once in-flight deliveries are recorded. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    // Never spin: at least 250 ms between passes, whatever the database says.
    const delay = Math.min(Math.max(250, delayMs), 2_147_000_000);
    const at = Date.now() + delay;
    if (this.timer && at >= this.dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }

  private tick(): Promise<void> {
    this.current = this.pass().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async pass() {
    this.timer = null;
    this.dueAt = Infinity;
    if (this.running || this.stopped) return this.schedule(1_000);
    this.running = true;
    try {
      const deps = this.deps();
      await deliverDue(deps, { shouldContinue: () => !this.stopped });
      this.failures = 0;
      if (Date.now() < this.eventWindowUntil) {
        this.schedule(this.opts.pollMs ?? 3_000);
      } else {
        const next = await nextDueAt(deps.db);
        if (next) this.schedule(Math.max(next.getTime() - Date.now(), 1_000));
      }
    } catch (err) {
      // Back off on repeated failures (database down, misconfiguration).
      this.failures += 1;
      if (this.failures <= 3) logger.error({ err }, 'webhook dispatcher pass failed');
      this.schedule(Math.min(30_000 * 2 ** (this.failures - 1), 30 * 60_000));
    } finally {
      this.running = false;
    }
  }
}
