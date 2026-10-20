import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { z, ZodError } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import type { Db } from '../db';
import type { AuthUser } from '../modules/auth/auth.service';
import { HttpError, toHttp } from '../http/errors';
import { canonicalJson } from '../modules/audit/hash-chain';

/**
 * The platform API framework. A route is declared ONCE — method, path, schemas,
 * docs, handler — and that single declaration produces:
 *   - the Express handler (auth, access level, input validation, idempotency),
 *   - its OpenAPI 3.1 operation (so the spec can't drift from the code),
 *   - optional response validation (on in tests: every response must match its schema).
 */

// ---- schema registry (OpenAPI components) ---------------------------------------------

export const registry = z.registry<{ id: string; description?: string }>();

/** Registers a named schema; it becomes `#/components/schemas/<id>`. */
export function named<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  registry.add(schema, { id, ...(description ? { description } : {}) });
  return schema;
}

export const ListMeta = { has_more: z.boolean(), next_cursor: z.string().nullable() };

/** `{ object: "list", data: [...], has_more, next_cursor }` for a named item schema. */
export function listOf<T extends z.ZodType>(id: string, item: T) {
  return named(`${id}List`, z.object({ object: z.literal('list'), data: z.array(item), ...ListMeta }));
}

// ---- errors ----------------------------------------------------------------------------

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'conflict_error',
  413: 'invalid_request_error',
  415: 'invalid_request_error',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
};
/** Internal service codes → the public error codes (documented in the API description). */
const CODE_ALIASES: Record<string, string> = {
  not_found: 'resource_missing',
  invalid: 'parameter_invalid',
  state: 'invalid_state',
  limit: 'resource_limit',
  unchanged: 'invalid_state',
  provider: 'paypal_unavailable',
  verification: 'payment_verification_failed',
};

const DEFAULT_CODES: Record<number, string> = {
  400: 'parameter_invalid', 401: 'unauthenticated', 403: 'forbidden', 404: 'resource_missing', 409: 'conflict', 422: 'unprocessable', 429: 'rate_limited',
};

export const ErrorSchema = named(
  'Error',
  z.object({
    error: z.object({
      type: z.enum(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'conflict_error', 'rate_limit_error', 'api_error']),
      code: z.string(),
      message: z.string(),
      param: z.string().optional(),
      details: z.unknown().optional(),
    }),
    request_id: z.string().nullable(),
  }),
  'Every error has this shape. `type` is the broad category, `code` the specific reason; `request_id` identifies the request in support logs.',
);

export function v1ErrorBody(err: unknown, requestId: string | null): { status: number; body: z.infer<typeof ErrorSchema>; retryAfter?: number } {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const param = issue?.path.join('.') || undefined;
    return {
      status: 400,
      body: {
        error: { type: 'invalid_request_error', code: 'parameter_invalid', message: issue ? `${param ? `${param}: ` : ''}${issue.message}` : 'Invalid request.', ...(param ? { param } : {}), details: err.issues },
        request_id: requestId,
      },
    };
  }
  const http = toHttp(err);
  const status = http.status;
  const details = http.details as { code?: unknown } | unknown[] | undefined;
  const raw = details && !Array.isArray(details) && typeof details.code === 'string' ? details.code : null;
  // Services use short internal codes; the API speaks one documented vocabulary.
  // (A service that hides someone else's record answers 404 "forbidden": that is "missing" to the caller.)
  const code = raw ? (raw === 'forbidden' && status === 404 ? 'resource_missing' : (CODE_ALIASES[raw] ?? raw)) : (DEFAULT_CODES[status] ?? 'api_error');
  const extra = details && !Array.isArray(details) ? Object.fromEntries(Object.entries(details).filter(([k]) => k !== 'code')) : details;
  return {
    status,
    body: {
      error: {
        type: (ERROR_TYPES[status] ?? 'api_error') as z.infer<typeof ErrorSchema>['error']['type'],
        code,
        message: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong on our side. Retry, and quote the request_id if it keeps happening.' : http.message,
        ...(extra && (Array.isArray(extra) ? extra.length : Object.keys(extra).length) ? { details: extra } : {}),
      },
      request_id: requestId,
    },
    retryAfter: http.retryAfterSeconds,
  };
}

export function v1ErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const { status, body, retryAfter } = v1ErrorBody(err, (req.id as string | undefined) ?? null);
  if (status >= 500) (req.log ?? console).error({ err }, 'platform api error');
  // A rate limiter already set the exact Retry-After; only fill it in when it didn't.
  if (retryAfter && !res.getHeader('Retry-After')) res.setHeader('Retry-After', String(retryAfter));
  res.status(status).json(body);
}

// ---- pagination -------------------------------------------------------------------------

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).meta({ description: 'Items per page, 1–100.' }),
  starting_after: z.string().max(300).optional().meta({ description: 'The `next_cursor` of the previous page.' }),
});

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url');
}

/** Prisma `where` for "older than the cursor", ordered by (createdAt desc, id desc). */
export function cursorWhere(cursor: string | undefined): { OR: object[] } | Record<string, never> {
  if (!cursor) return {};
  let at: Date;
  let id: string;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw new Error();
    at = new Date(parsed[0]);
    id = parsed[1];
    if (Number.isNaN(at.getTime())) throw new Error();
  } catch {
    throw new HttpError(400, 'starting_after is not a valid cursor. Use the next_cursor value of the previous page.', { code: 'invalid_cursor', param: 'starting_after' });
  }
  return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] };
}

export const pageOrder = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/** Fetch `limit + 1` rows ordered by `pageOrder`, then call this. */
export function toPage<R extends { createdAt: Date; id: string }, T>(rows: R[], limit: number, serialize: (row: R) => T) {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return { object: 'list' as const, data: page.map(serialize), has_more: hasMore, next_cursor: hasMore ? encodeCursor(page[page.length - 1]!) : null };
}

// ---- idempotency --------------------------------------------------------------------------

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** A first attempt that hasn't finished after this long (it heartbeats every 30 s) is assumed dead. */
const IN_PROGRESS_STALE_MS = 15 * 60_000;
const HEARTBEAT_MS = 30_000;
const KEY_TTL_MS = 24 * 3_600_000;

function requestHash(req: Request): string {
  return createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${canonicalJson(req.body ?? null)}`).digest('hex');
}

/** What gets stored for replay: never secrets (they are shown exactly once). */
function storable(body: unknown, secretFields: readonly string[]): unknown {
  if (!secretFields.length || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), ...Object.fromEntries(secretFields.map((f) => [f, null])) };
}

/**
 * `Idempotency-Key` on POST: the first request runs; a retry with the same key and
 * the same input gets the stored response (header `Idempotent-Replayed: true`); the
 * same key with different input is refused. Server errors (5xx) and rate limits
 * aren't stored, so they can be retried with the same key. Keys are per account
 * and kept 24 hours.
 *
 * The running request holds the key with a token it refreshes (heartbeat), so a
 * slow handler is never taken over and run twice, and only the holder can store
 * the final response.
 */
async function withIdempotency(
  db: Db,
  req: Request,
  res: Response,
  secretFields: readonly string[],
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  const key = req.header(IDEMPOTENCY_HEADER);
  if (key === undefined) return run();
  if (!/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw new HttpError(400, 'Idempotency-Key must be 1–255 visible ASCII characters.', { code: 'idempotency_key_invalid', param: IDEMPOTENCY_HEADER });
  }
  const userId = req.user!.id;
  const hash = requestHash(req);
  const now = new Date();

  let rowId: string;
  let token = now;
  try {
    rowId = (await db.idempotencyKey.create({ data: { userId, key, requestHash: hash, lockedAt: token }, select: { id: true } })).id;
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    let existing = await db.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
    // Keys live 24 hours, whether or not the cleanup sweep has run yet.
    if (existing && existing.statusCode !== null && Date.now() - existing.createdAt.getTime() > KEY_TTL_MS) {
      await db.idempotencyKey.deleteMany({ where: { id: existing.id, statusCode: { not: null } } });
      existing = null;
    }
    if (!existing) return withIdempotency(db, req, res, secretFields, run); // expired (or just removed)
    if (existing.requestHash !== hash) {
      throw new HttpError(422, 'This Idempotency-Key was already used with a different request. Use a new key for a new request.', { code: 'idempotency_key_reused' });
    }
    if (existing.statusCode !== null) {
      res.setHeader('Idempotent-Replayed', 'true');
      return { status: existing.statusCode, body: existing.responseBody };
    }
    if (now.getTime() - existing.lockedAt.getTime() < IN_PROGRESS_STALE_MS) {
      throw new HttpError(409, 'A request with this Idempotency-Key is still in progress. Retry shortly.', { code: 'idempotency_in_progress' });
    }
    // The first attempt stopped heartbeating long ago (crashed): take the key over.
    const taken = await db.idempotencyKey.updateMany({ where: { id: existing.id, statusCode: null, lockedAt: existing.lockedAt }, data: { lockedAt: token } });
    if (taken.count === 0) throw new HttpError(409, 'A request with this Idempotency-Key is still in progress. Retry shortly.', { code: 'idempotency_in_progress' });
    rowId = existing.id;
  }

  // Heartbeat: keep the claim fresh while the handler runs.
  // Heartbeat: keep the claim fresh while the handler runs. Updates are chained, so
  // the final write below always runs after the last one and uses its token.
  let held = true;
  let beat: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    beat = beat.then(async () => {
      const next = new Date();
      const r = await db.idempotencyKey.updateMany({ where: { id: rowId, statusCode: null, lockedAt: token }, data: { lockedAt: next } }).catch(() => null);
      if (r?.count === 1) token = next;
      else if (r) held = false;
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const settle = async () => {
    clearInterval(heartbeat);
    await beat;
  };

  let outcome: { status: number; body: unknown };
  try {
    outcome = await run();
  } catch (err) {
    const { status, body } = v1ErrorBody(err, (req.id as string | undefined) ?? null);
    if (status >= 500 || status === 429) {
      await settle();
      // Not a final answer: release the key so the same request can be retried.
      await db.idempotencyKey.deleteMany({ where: { id: rowId, statusCode: null, lockedAt: token } }).catch(() => undefined);
      throw err;
    }
    outcome = { status, body };
  }
  await settle();
  // Store the final answer — only while we still hold the key. A failure to store
  // must not turn a completed action into an error for the caller.
  if (held) {
    const stored = await db.idempotencyKey
      .updateMany({
        where: { id: rowId, statusCode: null, lockedAt: token },
        data: { statusCode: outcome.status, responseBody: storable(outcome.body, secretFields) as Prisma.InputJsonValue },
      })
      .catch((err) => {
        req.log?.error({ err }, 'could not store idempotent response');
        return null;
      });
    if (stored && stored.count === 0) req.log?.warn({ rowId }, 'idempotency key changed hands before the response was stored');
  } else {
    req.log?.warn({ rowId }, 'idempotency key was taken over while the request ran');
  }
  return outcome;
}

// ---- route definitions ----------------------------------------------------------------------

type Method = 'get' | 'post' | 'patch' | 'delete';

export interface RouteContext<P, Q, B> {
  req: Request;
  user: AuthUser;
  params: P;
  query: Q;
  body: B;
}

export interface RouteDef<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType> {
  method: Method;
  /** Express-style, relative to /api/v1, e.g. `/sales/:id`. */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  /** Success status (default 200). */
  status?: number;
  /** Error statuses worth documenting beyond the common ones. */
  errors?: number[];
  /** Per-account quotas etc. Run after the idempotency replay check, so a replay is never rate-limited. */
  middleware?: RequestHandler[];
  /** Who may call it (default: publishers and admins). */
  roles?: AuthUser['role'][];
  /** Response fields that are secrets: shown once, never stored for idempotent replay (replayed as null). */
  secretFields?: string[];
  handler: (ctx: RouteContext<z.infer<P>, z.infer<Q>, z.infer<B>>) => Promise<z.input<R> | z.infer<R>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteDef<any, any, any, any>;

export const routes: AnyRoute[] = [];

export function defineRoute<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}

export interface MountOptions {
  db: Db;
  /** Validate every response against its schema (tests). A mismatch becomes a 500. */
  validateResponses: boolean;
}

/** Runs Express middleware (e.g. a rate limiter) as a promise. */
function runMiddleware(mw: RequestHandler, req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    void mw(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });
}

export function mount(router: Router, defs: AnyRoute[], opts: MountOptions) {
  for (const def of defs) {
    // One entry per method+path (several app instances, e.g. in tests, mount the same routes).
    const existing = routes.findIndex((r) => r.method === def.method && r.path === def.path);
    if (existing >= 0) routes[existing] = def;
    else routes.push(def);
    const roles = def.roles ?? ['publisher', 'admin'];
    const handler: RequestHandler = async (req, res) => {
      const user = req.user!;
      if (!roles.includes(user.role)) {
        throw new HttpError(403, `This request needs a ${roles.join(' or ')} account.`, { code: 'forbidden' });
      }
      // Read-only API keys: GET only.
      if (def.method !== 'get' && req.apiKey?.access === 'read_only') {
        throw new HttpError(403, 'This API key is read-only. Use a read & write key for this request.', { code: 'read_only_key' });
      }
      const params = def.params ? def.params.parse(req.params) : {};
      const query = def.query ? def.query.parse(req.query) : {};
      const body = def.body ? def.body.parse(req.body ?? {}) : {};

      const run = async () => {
        for (const mw of def.middleware ?? []) await runMiddleware(mw, req, res);
        const result = await def.handler({ req, user, params, query, body });
        if (opts.validateResponses) {
          const check = def.response.safeParse(result);
          if (!check.success) throw new Error(`Response of ${def.operationId} does not match its schema: ${JSON.stringify(check.error.issues.slice(0, 3))}`);
        }
        return { status: def.status ?? 200, body: result as unknown };
      };
      const outcome = def.method === 'post' ? await withIdempotency(opts.db, req, res, def.secretFields ?? [], run) : await run();
      res.status(outcome.status).json(outcome.body);
    };
    router[def.method](def.path, handler);
  }
}

// ---- OpenAPI 3.1 ------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** zod → JSON Schema, with registered schemas as component $refs and noise removed. */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonObject {
  // `uri` is honoured for single schemas too (registered sub-schemas become $refs), though the typings omit it.
  const params = { metadata: registry, uri: (id: string) => `#/components/schemas/${id}`, io, unrepresentable: 'any' } as unknown as Parameters<typeof z.toJSONSchema>[1];
  const out = z.toJSONSchema(schema, params) as JsonObject;
  return clean(out) as JsonObject;
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node as JsonObject)) {
    if (k === '$schema' || k === '$id' || k === '$defs') continue;
    // Responses may gain fields over time: clients must ignore unknown ones.
    if (k === 'additionalProperties' && v === false) continue;
    if (k === '$ref' && typeof v === 'string') {
      out[k] = v.replace(/^#\/\$defs\//, '#/components/schemas/');
      continue;
    }
    out[k] = clean(v);
  }
  return out;
}

function parameters(schema: z.ZodType | undefined, location: 'path' | 'query'): JsonObject[] {
  if (!schema) return [];
  const js = jsonSchema(schema, 'input') as { properties?: Record<string, JsonObject>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, prop]) => {
    const { description, ...rest } = prop as { description?: string };
    return { name, in: location, required: location === 'path' || (js.required ?? []).includes(name), ...(description ? { description } : {}), schema: rest };
  });
}

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

export function buildOpenApi(opts: { serverUrl: string; title: string; version: string; description: string; tags: { name: string; description: string }[]; extraComponents?: JsonObject; webhooks?: JsonObject }) {
  const paths: Record<string, JsonObject> = {};
  for (const def of routes) {
    const path = def.path.replace(/:(\w+)/g, '{$1}');
    const errors = new Set([400, 401, 403, 429, ...(def.params ? [404] : []), ...(def.errors ?? []), ...(def.method === 'post' ? [409, 422] : [])]);
    const op: JsonObject = {
      operationId: def.operationId,
      tags: [def.tag],
      summary: def.summary,
      ...(def.description ? { description: def.description } : {}),
      parameters: [
        ...parameters(def.params, 'path'),
        ...parameters(def.query, 'query'),
        ...(def.method === 'post'
          ? [{ name: IDEMPOTENCY_HEADER, in: 'header', required: false, description: 'Makes the request safe to retry: the same key and body return the first response instead of running again. Kept for 24 hours.', schema: { type: 'string', maxLength: 255 } }]
          : []),
      ],
      ...(def.body
        ? { requestBody: { required: !def.body.safeParse(undefined).success, content: { 'application/json': { schema: jsonSchema(def.body, 'input') } } } }
        : {}),
      responses: {
        [String(def.status ?? 200)]: { description: 'Success', content: { 'application/json': { schema: jsonSchema(def.response, 'output') } } },
        ...Object.fromEntries([...errors].sort().map((s) => [String(s), errorResponse(ERROR_DESCRIPTIONS[s] ?? 'Error')])),
      },
      ...(def.method !== 'get' ? { 'x-required-access': 'read_write' } : {}),
    };
    paths[path] = { ...(paths[path] ?? {}), [def.method]: op };
  }
  const components = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}`, io: 'output', unrepresentable: 'any' }) as { schemas: JsonObject };
  return {
    openapi: '3.1.0',
    info: { title: opts.title, version: opts.version, description: opts.description, license: { name: 'MIT', identifier: 'MIT' } },
    servers: [
      { url: opts.serverUrl, description: 'API (PayPal sandbox environment)' },
      { url: '/api/v1', description: 'The same API through the web app you are viewing these docs on' },
    ],
    security: [{ apiKey: [] }],
    tags: opts.tags,
    paths,
    ...(opts.webhooks ? { webhooks: opts.webhooks } : {}),
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'tp_…', description: 'An API key from the Developers page: `Authorization: Bearer tp_…`. Read-only keys can only make GET requests.' },
      },
      schemas: clean(components.schemas),
      ...(opts.extraComponents ?? {}),
    },
  };
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request: a parameter is missing or wrong (`param` names it).',
  401: 'Missing, invalid, expired or revoked API key.',
  403: 'The key is read-only, or the account may not do this.',
  404: 'Not found — or it belongs to another account.',
  409: 'Conflicts with the current state (or an idempotent request is still running).',
  422: 'Well-formed but can’t be processed, e.g. an Idempotency-Key reused with a different body.',
  429: 'Too many requests. Wait for the `Retry-After` seconds.',
};
