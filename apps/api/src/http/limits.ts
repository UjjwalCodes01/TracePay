import { rateLimit } from 'express-rate-limit';

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
    message: { error: message },
  });
}

const HOUR = 60 * 60_000;

export const quotas = {
  createAsset: () => perUser('asset', 20, HOUR, 'You can add up to 20 sources per hour.'),
  addVersion: () => perUser('version', 60, HOUR, 'You can upload up to 60 versions per hour.'),
  offer: () => perUser('offer', 60, HOUR, 'You can send up to 60 license offers per hour.'),
  request: () => perUser('request', 60, HOUR, 'You can send up to 60 license requests per hour.'),
  checkout: () => perUser('checkout', 30, 10 * 60_000, 'Too many checkout attempts. Try again in a few minutes.'),
  agentRun: () => perUser('agent', 30, HOUR, 'You can start up to 30 assistant runs per hour.'),
  preflight: () => perUser('preflight', 120, HOUR, 'Too many preflight checks this hour.'),
};
