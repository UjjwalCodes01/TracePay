import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { HttpError } from './errors';

/**
 * Per-ACCOUNT quotas for writes that cost storage, money or model calls.
 * Keyed by the signed-in user, so they hold even when many users share an IP
 * (e.g. behind a proxy) and can't be dodged by rotating IPs.
 */
export function perUser(name: string, limit: number, windowMs: number, message: string) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: (req) => `${name}:${req.user?.id ?? 'anonymous'}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, _res, next) => next(new HttpError(429, message, { code: 'quota_exceeded' }, secondsUntilReset(req, windowMs))),
  });
}

const HOUR = 60 * 60_000;

/** Seconds until the limiter's window resets (what Retry-After should say). */
export function secondsUntilReset(req: object, fallbackMs: number): number {
  // express-rate-limit attaches its counters to the request.
  const reset = (req as { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime?.getTime();
  return Math.max(1, Math.ceil(((reset ?? Date.now() + fallbackMs) - Date.now()) / 1000));
}

/** One limiter per quota, shared by the dashboard and the platform API (separate instances would double the allowance). */
const shared = new Map<string, { limiter: RateLimitRequestHandler; prefix: string }>();
const once = (name: string, prefix: string, make: () => RateLimitRequestHandler) => () => {
  let entry = shared.get(name);
  if (!entry) shared.set(name, (entry = { limiter: make(), prefix }));
  return entry.limiter;
};

/** Clears one account's quota counters (tests, and support tooling). */
export async function resetQuotas(userId: string): Promise<void> {
  await Promise.all([...shared.values()].map((e) => e.limiter.resetKey(`${e.prefix}:${userId}`)));
}

export const quotas = {
  createAsset: once('createAsset', 'asset', () => perUser('asset', 20, HOUR, 'You can add up to 20 sources per hour.')),
  addVersion: once('addVersion', 'version', () => perUser('version', 60, HOUR, 'You can upload up to 60 versions per hour.')),
  offer: once('offer', 'offer', () => perUser('offer', 60, HOUR, 'You can send up to 60 license offers per hour.')),
  request: once('request', 'request', () => perUser('request', 60, HOUR, 'You can send up to 60 license requests per hour.')),
  checkout: once('checkout', 'checkout', () => perUser('checkout', 30, 10 * 60_000, 'Too many checkout attempts. Try again in a few minutes.')),
  agentRun: once('agentRun', 'agent', () => perUser('agent', 30, HOUR, 'You can start up to 30 assistant runs per hour.')),
  preflight: once('preflight', 'preflight', () => perUser('preflight', 120, HOUR, 'Too many preflight checks this hour.')),
  /** Each makes an outbound HTTP request to a customer URL: keep TracePay from being used as a request cannon. */
  webhookTest: once('webhookTest', 'webhook-test', () => perUser('webhook-test', 30, 10 * 60_000, 'Too many test events. Try again in a few minutes.')),
  webhookResend: once('webhookResend', 'webhook-resend', () => perUser('webhook-resend', 300, HOUR, 'Too many redeliveries this hour.')),
  webhookManage: once('webhookManage', 'webhook-manage', () => perUser('webhook-manage', 60, HOUR, 'Too many webhook endpoint changes this hour.')),
};
