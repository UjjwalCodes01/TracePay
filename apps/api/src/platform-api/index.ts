import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { limitStore } from '../http/rate-store';
import { HttpError } from '../http/errors';
import { secondsUntilReset } from '../http/limits';
import { EVENT_DATA_SHAPES, EVENT_TYPES } from '../modules/platform/events';
import { SIGNATURE_HEADER, SIGNATURE_TOLERANCE_SECONDS } from '../modules/platform/webhook-crypto';
import { buildOpenApi, mount, routes, v1ErrorHandler } from './framework';
import { buyerRoutes } from './buyer-routes';
import { platformRoutes, type PlatformDeps } from './routes';
import { Event } from './resources';

export const API_VERSION = '1.0.0';

const DESCRIPTION = `
The TracePay platform API lets your software do everything the dashboard does: check licenses before
an AI report is built, generate citation-checked reports, follow sales, approve settlements, send PayPal
payouts and fetch signed audit receipts — plus receive **webhooks** when anything happens.

Everything runs on the **PayPal sandbox**.

## Authentication
Create an API key on the **Developers** page and send it as \`Authorization: Bearer tp_…\`.
Read-only keys can make GET requests only. Keys can expire and be revoked at any time.

## Conventions
- JSON in and out, \`snake_case\` fields, timestamps in ISO-8601, money as integer **cents**.
- Lists return \`{ object: "list", data, has_more, next_cursor }\`; pass \`next_cursor\` as \`starting_after\` for the next page.
- Errors return \`{ error: { type, code, message, param? }, request_id }\` with a matching HTTP status. Common codes:
  \`parameter_invalid\`, \`invalid_json\`, \`invalid_cursor\`, \`unauthenticated\`, \`invalid_api_key\`, \`read_only_key\`, \`forbidden\`,
  \`publisher_account_required\`, \`resource_missing\`, \`route_not_found\`, \`conflict\`, \`invalid_state\`, \`resource_limit\`,
  \`too_many_active_runs\`, \`rights_not_satisfied\`, \`generation_failed\`, \`idempotency_key_reused\`, \`idempotency_in_progress\`,
  \`rate_limited\`, \`quota_exceeded\`, \`paypal_unavailable\`, \`payouts_unavailable\`, \`not_for_sale\`.
- **Idempotency:** send an \`Idempotency-Key\` header with any POST to make it safe to retry. The same key and body
  return the first response (header \`Idempotent-Replayed: true\`); the same key with a different body is refused (\`422\`).
- **Rate limits:** per API key; \`429\` responses carry \`Retry-After\`. Standard \`RateLimit\` headers show what is left.

## Webhooks
Add an endpoint (\`POST /webhook_endpoints\`) and TracePay POSTs an [Event](#model/event) to it whenever something happens.

- Every delivery is signed: \`${SIGNATURE_HEADER}: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>\`.
  Compute the HMAC over the **raw** request body, compare in constant time, and reject timestamps more than
  ${SIGNATURE_TOLERANCE_SECONDS / 60} minutes old. During a secret rotation there are two \`v1\` values; accept either.
- Answer with any \`2xx\` within 10 seconds. Anything else (including redirects) is retried with backoff for about
  27 hours (1 min, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h). An endpoint failing for 3 days, or answering \`410 Gone\`, is disabled.
- Delivery is **at least once** and not ordered: de-duplicate on the event \`id\` and fetch the object for its current state.
- Payloads are thin (ids and a few fields), so they never carry source content or payout addresses.
- Missed something? \`GET /events\` lists the last 30 days.

Verification in Node.js:

\`\`\`js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.groupBy(header.split(',').map((p) => p.split('=')), ([k]) => k);
  const t = Number(parts.t?.[0]?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  return (parts.v1 ?? []).some(([, sig]) => {
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
\`\`\`
`.trim();

const TAGS = [
  { name: 'Account', description: 'Who the credentials belong to.' },
  { name: 'Sources & licenses', description: 'Licensable sources, and the two-party license lifecycle (request → offer → accept).' },
  { name: 'Builds & reports', description: 'License preflight, citation-checked generation, reports, receipts and provenance.' },
  { name: 'Sales & settlements', description: 'PayPal sales of your reports, revenue splits and PayPal payouts.' },
  { name: 'Reconciliation', description: 'TracePay checks payments and payouts with PayPal on a schedule and lists what needs you.' },
  { name: 'Publisher Agent', description: 'The bounded agent that plans a report, fixes license problems and asks before risky steps.' },
  { name: 'Events & webhooks', description: 'The event log and signed webhook deliveries.' },
  { name: 'Answers (pay-per-citation)', description: 'For buyer accounts and their AI agents: ask questions answered only from licensed sources. Each answer pays the contributors whose passages it verifiably relies on, within your price limit, with a signed receipt.' },
  { name: 'Buying', description: 'For buyer accounts and their AI agents: search, check licenses, check out. The buyer approves every payment at PayPal.' },
];

export interface PlatformApiOptions {
  serverUrl: string;
  rateLimitPerMinute: number;
  validateResponses: boolean;
}

let cachedSpec: unknown = null;

/** The OpenAPI document (built once per process). */
export function openApiDocument(serverUrl: string) {
  if (cachedSpec) return cachedSpec;
  cachedSpec = buildOpenApi({
    serverUrl,
    title: 'TracePay API',
    version: API_VERSION,
    description: DESCRIPTION,
    tags: TAGS,
    webhooks: Object.fromEntries(
      EVENT_TYPES.map((e) => [
        e.type,
        {
          post: {
            summary: e.type,
            description: `${e.description}\n\n\`data\`: \`object_type\` = \`${EVENT_DATA_SHAPES[e.type]?.objectType}\`, \`object_id\`${
              EVENT_DATA_SHAPES[e.type]?.objectType === 'report' || e.type === 'ping' ? '' : ', `report_id` (when the object belongs to a report)'
            }${(EVENT_DATA_SHAPES[e.type]?.fields ?? []).map((f) => `, \`${f}\``).join('')}.`,
            parameters: [{ name: SIGNATURE_HEADER, in: 'header', required: true, schema: { type: 'string' }, description: 'Signature to verify with your endpoint secret.' }],
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } },
            responses: { '200': { description: 'Any 2xx acknowledges the event.' } },
          },
        },
      ]),
    ),
  });
  return cachedSpec;
}

/** Mounted at /api/v1. Relies on the app-wide `authenticate` and CSRF origin check. */
export function platformApi(deps: PlatformDeps, opts: PlatformApiOptions): Router {
  const r = Router();

  // Public: the spec itself.
  r.get('/openapi.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(openApiDocument(opts.serverUrl));
  });

  // Everything else needs a publisher (or admin) account — except buying, which is for buyers.
  r.use((req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Send an API key: Authorization: Bearer tp_…', { code: 'unauthenticated' }));
    if (req.user.role === 'buyer' && /^\/(store|checkouts|account|libraries|credits|credit_top_ups|answers)(\/|$)/.test(req.path)) return next();
    if (req.user.role !== 'publisher' && req.user.role !== 'admin') {
      return next(new HttpError(403, 'The platform API is available to publisher accounts.', { code: 'publisher_account_required' }));
    }
    next();
  });

  // Per credential, so integrations behind one IP don't share a limit.
  r.use(
    rateLimit({ ...limitStore('v1-key'),
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.id}` : `user:${req.user!.id}`),
      handler: (req, _res, next) => next(new HttpError(429, 'Too many requests for this API key. Slow down and retry after the Retry-After seconds.', { code: 'rate_limited' }, secondsUntilReset(req, 60_000))),
    }),
  );

  // …and per account, so many keys can't multiply one account's allowance.
  r.use(
    rateLimit({ ...limitStore('v1-account'),
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute * 2,
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: (req) => `account:${req.user!.id}`,
      handler: (req, _res, next) => next(new HttpError(429, 'Too many requests for this account. Slow down and retry after the Retry-After seconds.', { code: 'rate_limited' }, secondsUntilReset(req, 60_000))),
    }),
  );

  mount(r, [...platformRoutes(deps), ...buyerRoutes(deps)], { db: deps.db, validateResponses: opts.validateResponses });

  r.use((_req, _res, next) => next(new HttpError(404, 'No such endpoint. See /api/v1/openapi.json.', { code: 'route_not_found' })));
  r.use(v1ErrorHandler);
  return r;
}

export { routes, Event };
