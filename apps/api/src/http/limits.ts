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
    handler: (_req, _res, next) => next(new HttpError(429, message, { code: 'quota_exceeded' }, Math.ceil(windowMs / 1000))),
  });
}

const HOUR = 60 * 60_000;

/** One limiter per quota, shared by the dashboard and the platform API (separate instances would double the allowance). */
const shared = new Map<string, RateLimitRequestHandler>();
const once = (name: string, make: () => RateLimitRequestHandler) => () => {
  let limiter = shared.get(name);
  if (!limiter) shared.set(name, (limiter = make()));
  return limiter;
};

export const quotas = {
  createAsset: once('createAsset', () => perUser('asset', 20, HOUR, 'You can add up to 20 sources per hour.')),
  addVersion: once('addVersion', () => perUser('version', 60, HOUR, 'You can upload up to 60 versions per hour.')),
  offer: once('offer', () => perUser('offer', 60, HOUR, 'You can send up to 60 license offers per hour.')),
  request: once('request', () => perUser('request', 60, HOUR, 'You can send up to 60 license requests per hour.')),
  checkout: once('checkout', () => perUser('checkout', 30, 10 * 60_000, 'Too many checkout attempts. Try again in a few minutes.')),
  agentRun: once('agentRun', () => perUser('agent', 30, HOUR, 'You can start up to 30 assistant runs per hour.')),
  preflight: once('preflight', () => perUser('preflight', 120, HOUR, 'Too many preflight checks this hour.')),
  /** Each makes an outbound HTTP request to a customer URL: keep TracePay from being used as a request cannon. */
  webhookTest: once('webhookTest', () => perUser('webhook-test', 30, 10 * 60_000, 'Too many test events. Try again in a few minutes.')),
  webhookResend: once('webhookResend', () => perUser('webhook-resend', 300, HOUR, 'Too many redeliveries this hour.')),
  webhookManage: once('webhookManage', () => perUser('webhook-manage', 60, HOUR, 'Too many webhook endpoint changes this hour.')),
};
