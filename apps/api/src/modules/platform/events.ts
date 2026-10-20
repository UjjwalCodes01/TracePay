import { randomBytes } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../db';

/**
 * The public event catalog of the platform API.
 *
 * Every public event mirrors one audit-chain event and is written in the SAME
 * transaction (a transactional outbox): an event exists if and only if the change
 * it describes committed. Payloads are deliberately thin — ids plus a few curated
 * fields — so a webhook can never leak source content, contributors' payout
 * addresses or raw PayPal payloads. Receivers fetch full objects through the API.
 */

export type ObjectType = 'build' | 'report' | 'sale' | 'settlement' | 'payout_batch' | 'license' | 'agent_run' | 'webhook_endpoint';

interface EventSpec {
  type: string;
  object: ObjectType;
  /** Audit payload fields that may be shown to the publisher, in camelCase. */
  fields?: readonly string[];
  description: string;
}

/** Audit event type → public event. Audit events not listed here stay internal. */
const CATALOG: Record<string, EventSpec> = {
  'build.preflight_passed': { type: 'build.preflight_passed', object: 'build', fields: ['snapshotHash'], description: 'A license preflight passed: the build may be generated.' },
  'build.preflight_blocked': { type: 'build.preflight_blocked', object: 'build', fields: ['failedRules'], description: 'A license preflight failed; `failed_rules` says which rule blocked which source.' },
  'build.generation_rejected': { type: 'build.generation_failed', object: 'build', fields: ['attempts'], description: 'Report generation failed citation validation; nothing was published.' },
  'build.rights_changed': { type: 'build.generation_failed', object: 'build', fields: ['reasons'], description: 'A source license changed after the preflight, so generation stopped.' },

  'artifact.generated': { type: 'report.created', object: 'report', fields: ['buildId', 'contentHash', 'model', 'fromFixture'], description: 'A report was generated from a passed build.' },
  'artifact.withdrawn': { type: 'report.withdrawn', object: 'report', fields: ['reasons'], description: 'A report was taken off sale (by the publisher, or because a source license no longer allows it).' },
  'artifact.relisted': { type: 'report.relisted', object: 'report', description: 'A report was put back on sale.' },

  'sale.created': { type: 'sale.created', object: 'sale', fields: ['amountCents', 'currency'], description: 'A buyer started a PayPal checkout.' },
  'sale.captured': { type: 'sale.completed', object: 'sale', fields: ['orderId', 'captureId', 'capturedCents'], description: 'PayPal captured the payment; a settlement is calculated next.' },
  'sale.capture_pending': { type: 'sale.pending', object: 'sale', fields: ['orderId', 'captureId'], description: 'PayPal accepted the payment but holds it as pending.' },
  'sale.capture_exception': { type: 'sale.exception', object: 'sale', fields: ['orderId', 'captureId', 'problems'], description: 'The capture did not match the sale (amount, currency or status) and needs review.' },
  'sale.blocked_before_capture': { type: 'sale.blocked', object: 'sale', fields: ['reasons'], description: 'The rights re-check before capture failed, so the payment was not taken.' },
  'sale.refunded': { type: 'sale.refunded', object: 'sale', fields: ['captureId', 'refundedCents'], description: 'The payment was refunded in full; its settlement is flagged as an exception.' },
  'sale.partially_refunded': { type: 'sale.partially_refunded', object: 'sale', fields: ['captureId', 'refundedCents'], description: 'Part of the payment was refunded; its settlement is flagged as an exception.' },
  'sale.reversed': { type: 'sale.reversed', object: 'sale', fields: ['captureId'], description: 'The payment was reversed (for example a chargeback).' },

  'settlement.calculated': { type: 'settlement.created', object: 'settlement', fields: ['saleId', 'grossCents', 'contributorTotalCents', 'publisherResidualCents'], description: 'The revenue split for a sale was calculated and awaits approval.' },
  'settlement.approved': { type: 'settlement.approved', object: 'settlement', description: 'The publisher approved the settlement; payouts can be sent.' },
  'settlement.completed': { type: 'settlement.completed', object: 'settlement', fields: ['reason'], description: 'Every payout of the settlement finished.' },
  'settlement.failed': { type: 'settlement.failed', object: 'settlement', fields: ['saleId', 'reason'], description: 'The settlement could not be calculated; fix the cause and recalculate.' },
  'settlement.recalculated': { type: 'settlement.recalculated', object: 'settlement', fields: ['replaces'], description: 'A failed settlement was calculated again.' },

  'payout.submitted': { type: 'payout_batch.submitted', object: 'payout_batch', fields: ['attempt', 'paypalBatchId', 'batchStatus'], description: 'A PayPal Payouts batch was sent.' },
  'payout.status_refreshed': { type: 'payout_batch.updated', object: 'payout_batch', fields: ['attempt', 'paypalBatchId', 'batchStatus', 'runStatus'], description: 'PayPal reported new payout statuses.' },
  'payout.submit_failed': { type: 'payout_batch.submit_failed', object: 'payout_batch', fields: ['retrySafe'], description: 'PayPal did not accept the batch. Nothing was paid; it is safe to retry.' },
  'payout.duplicate_detected': { type: 'payout_batch.awaiting_confirmation', object: 'payout_batch', description: 'PayPal already had this batch (an earlier response was lost). Nothing was paid twice; awaiting PayPal’s confirmation.' },
  'payout.retry_created': { type: 'payout_batch.retry_created', object: 'payout_batch', fields: ['attempt'], description: 'Failed payouts were queued again as a new attempt.' },

  'license.requested': { type: 'license.requested', object: 'license', description: 'You requested a license.' },
  'license.offered': { type: 'license.offered', object: 'license', fields: ['version', 'termsHash'], description: 'A contributor offered license terms; accept them with the same `terms_hash`.' },
  'license.accepted': { type: 'license.accepted', object: 'license', fields: ['version', 'termsHash'], description: 'A license became binding.' },
  'license.declined': { type: 'license.declined', object: 'license', fields: ['reason'], description: 'You declined an offer.' },
  'license.withdrawn': { type: 'license.withdrawn', object: 'license', fields: ['reason'], description: 'The contributor withdrew an offer.' },
  'license.request_declined': { type: 'license.request_declined', object: 'license', fields: ['reason'], description: 'The contributor declined your request.' },
  'license.revoked': { type: 'license.revoked', object: 'license', fields: ['reason', 'reportsWithdrawn'], description: 'The contributor revoked a license. Reports using it are taken off sale; past settlements are unaffected.' },

  'agent.started': { type: 'agent_run.started', object: 'agent_run', description: 'A Publisher Agent run started.' },
  'agent.awaiting_approval': { type: 'agent_run.awaiting_approval', object: 'agent_run', description: 'The agent paused for your approval.' },
  'agent.replacement_approved': { type: 'agent_run.approval_given', object: 'agent_run', description: 'You approved the agent’s proposal.' },
  'agent.replacement_declined': { type: 'agent_run.approval_declined', object: 'agent_run', description: 'You declined the agent’s proposal.' },
  'agent.completed': { type: 'agent_run.completed', object: 'agent_run', description: 'An agent run finished.' },
  'agent.failed': { type: 'agent_run.failed', object: 'agent_run', description: 'An agent run failed.' },
};

/** Sent only on request, to check an endpoint. */
export const PING_EVENT = { type: 'ping', description: 'A test event sent from the dashboard or `POST /webhook_endpoints/{id}/test`.' };

const AUDIT_ENTITY_TO_OBJECT: Record<string, ObjectType> = {
  build: 'build',
  artifact: 'report',
  sale: 'sale',
  settlement: 'settlement',
  payout_batch: 'payout_batch',
  license: 'license',
  agent_run: 'agent_run',
};

/** Every public event type with its description, for docs and endpoint validation. */
export const EVENT_TYPES: { type: string; description: string }[] = [
  ...[...new Map(Object.values(CATALOG).map((s) => [s.type, s.description])).entries()].map(([type, description]) => ({ type, description })),
  PING_EVENT,
].sort((a, b) => a.type.localeCompare(b.type));

export const EVENT_TYPE_NAMES = new Set(EVENT_TYPES.map((e) => e.type));

export const newEventId = () => `evt_${randomBytes(16).toString('hex')}`;
export const newDeliveryId = () => `whd_${randomBytes(16).toString('hex')}`;

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
function toSnake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnake);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [snake(k), toSnake(v)]));
  }
  return value;
}

export interface PublicEventData {
  object_type: ObjectType;
  object_id: string;
  report_id?: string;
  [field: string]: unknown;
}

/** The public form of an audit event, or null if it isn't part of the public catalog. */
export function publicEventFor(input: {
  entityType: string;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
  artifactId?: string | null;
}): { type: string; data: PublicEventData } | null {
  const spec = CATALOG[input.eventType];
  const object = AUDIT_ENTITY_TO_OBJECT[input.entityType];
  if (!spec || !object) return null;
  const data: PublicEventData = { object_type: object, object_id: input.entityId };
  if (input.artifactId && object !== 'report') data.report_id = input.artifactId;
  for (const field of spec.fields ?? []) {
    if (input.payload[field] !== undefined) data[snake(field)] = toSnake(input.payload[field]);
  }
  return { type: spec.type, data };
}

/** Called after events are written, so the delivery worker can wake up. Set by the server. */
let outboxListener: (() => void) | null = null;
export function setOutboxListener(listener: (() => void) | null) {
  outboxListener = listener;
}

/**
 * Writes the public event for an audit event (same transaction) and queues one
 * delivery per enabled webhook endpoint of the owner that subscribes to it.
 * Endpoints created later never receive older events.
 */
export async function recordPublicEvent(
  tx: Tx,
  input: {
    auditSeq: number | null;
    ownerId: string;
    type: string;
    data: PublicEventData | Record<string, unknown>;
    createdAt: Date;
    /** Send to this endpoint only (test pings). */
    onlyEndpointId?: string;
    /** Create the deliveries already leased to the caller, which sends them itself. */
    leasedUntil?: Date;
  },
): Promise<{ eventId: string; deliveries: number }> {
  const eventId = newEventId();
  await tx.outboundEvent.create({
    data: { id: eventId, ownerId: input.ownerId, type: input.type, data: input.data as Prisma.InputJsonValue, auditSeq: input.auditSeq, createdAt: input.createdAt },
  });
  const endpoints = await tx.webhookEndpoint.findMany({
    where: input.onlyEndpointId
      ? { id: input.onlyEndpointId, ownerId: input.ownerId }
      : { ownerId: input.ownerId, status: 'enabled', OR: [{ enabledEvents: { has: '*' } }, { enabledEvents: { has: input.type } }] },
    select: { id: true },
  });
  if (endpoints.length) {
    await tx.webhookDelivery.createMany({
      data: endpoints.map((e) => ({ id: newDeliveryId(), eventId, endpointId: e.id, nextAttemptAt: input.createdAt, lockedUntil: input.leasedUntil ?? null })),
    });
    if (!input.leasedUntil) outboxListener?.();
  }
  return { eventId, deliveries: endpoints.length };
}
