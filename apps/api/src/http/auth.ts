import type { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Db } from '../db';
import { userForApiKey, userForSession, type ApiKeyInfo, type AuthUser, type Role } from '../modules/auth/auth.service';
import { sha256 } from '../modules/auth/crypto';
import { DEMO_USERS, demoRoleOf, worldOf } from '../modules/demo/world';
import { DEMO_WORLD_HEADER, verifyDemoWorld } from '../modules/demo/worlds';
import { HttpError } from './errors';

export type { Role };
export type DemoUser = AuthUser;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      authMethod?: 'session' | 'api_key' | 'demo';
      /** Set when authenticated with an API key. */
      apiKey?: ApiKeyInfo;
    }
  }
}

export const DEMO_USER_HEADER = 'x-demo-user';

/** True for the platform API, the only place API keys are accepted. */
export const isPlatformApiPath = (url: string) => url === '/api/v1' || url.startsWith('/api/v1/') || url.startsWith('/api/v1?');
/** Shape of a key we issue (`tp_` + 32 base64url characters), checked before touching the database. */
export const WELL_FORMED_KEY = /^tp_[A-Za-z0-9_-]{20,100}$/;
const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/** The bearer token, '' for a malformed Bearer header, null when there is none. Case-insensitive, as RFC 7235 says. */
export function bearerToken(req: Request): string | null {
  const header = req.header('authorization')?.trim();
  if (!header || !/^bearer\b/i.test(header)) return null;
  return BEARER.exec(header)?.[1] ?? '';
}

/**
 * Brute-force guard for API keys: rejected keys are counted per client address
 * (IPv6 by /56, so rotating addresses inside one allocation doesn't help), and
 * once an address has too many it gets 429 for further invalid keys — decided
 * BEFORE any database lookup. Valid keys are never blocked. Bounded memory; per
 * process.
 */
const BAD_KEY_LIMIT = 30;
const BAD_KEY_WINDOW_MS = 10 * 60_000;
const BAD_KEY_MAX_TRACKED = 50_000;
const badKeys = new Map<string, { count: number; resetAt: number }>();
function badKeyBlocked(key: string, now = Date.now()): boolean {
  const entry = badKeys.get(key);
  return Boolean(entry && entry.resetAt > now && entry.count >= BAD_KEY_LIMIT);
}
/**
 * Keys verified in the last minute. While an address is throttled, only these
 * still work (no database lookup), so an integration that shares an address with
 * a key-guesser keeps running. Bounded; entries expire after a minute, so a
 * revoked key stops working within one.
 */
const RECENT_KEY_TTL_MS = 60_000;
const RECENT_KEYS_MAX = 10_000;
const recentKeys = new Map<string, { found: { user: AuthUser; apiKey: ApiKeyInfo }; at: number }>();
function rememberKey(hash: string, found: { user: AuthUser; apiKey: ApiKeyInfo }, now = Date.now()) {
  recentKeys.delete(hash);
  while (recentKeys.size >= RECENT_KEYS_MAX) recentKeys.delete(recentKeys.keys().next().value!);
  recentKeys.set(hash, { found, at: now });
}
function recentlyVerified(hash: string, now = Date.now()) {
  const hit = recentKeys.get(hash);
  return hit && now - hit.at < RECENT_KEY_TTL_MS ? hit.found : null;
}

function recordBadKey(key: string, now = Date.now()) {
  const entry = badKeys.get(key);
  if (entry && entry.resetAt > now) {
    entry.count += 1;
    return;
  }
  badKeys.delete(key);
  // Oldest entries go first (Map keeps insertion order): O(1), never unbounded.
  while (badKeys.size >= BAD_KEY_MAX_TRACKED) badKeys.delete(badKeys.keys().next().value!);
  badKeys.set(key, { count: 1, resetAt: now + BAD_KEY_WINDOW_MS });
}

const DEMO_PERSONAS = new Set(DEMO_USERS.filter((u) => u.role !== 'admin').map((u) => u.id));
export const SESSION_COOKIE = 'tp_session';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Resolves the caller, in order of precedence:
 *   1. `Authorization: Bearer tp_…` — an API key, for platforms integrating TracePay;
 *   2. the `tp_session` httpOnly cookie — a signed-in user;
 *   3. `X-Demo-User` — the hackathon role switcher, honoured ONLY when DEMO_MODE is on.
 */
export function authenticate(db: Db, opts: { demoMode: boolean }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const apiKeyToken = bearerToken(req);
    if (apiKeyToken !== null) {
      // Least privilege: keys are for the platform API. Dashboard routes (payout
      // details, key management…) only accept signed-in sessions.
      if (!isPlatformApiPath(req.originalUrl)) {
        return next(new HttpError(401, 'API keys work with the platform API (/api/v1) only.', { code: 'api_key_not_accepted_here' }));
      }
      const client = ipKeyGenerator(req.ip ?? 'unknown', 56);
      const wellFormed = WELL_FORMED_KEY.test(apiKeyToken);
      const hash = wellFormed ? sha256(apiKeyToken) : '';
      let found: { user: AuthUser; apiKey: ApiKeyInfo } | null;
      if (badKeyBlocked(client)) {
        // Throttled: no database work for this address, only keys verified moments ago.
        found = wellFormed ? recentlyVerified(hash) : null;
        if (!found) {
          return next(new HttpError(429, 'Too many invalid API keys from this address. Try again later.', { code: 'rate_limited' }, Math.ceil(BAD_KEY_WINDOW_MS / 1000)));
        }
      } else {
        found = wellFormed ? await userForApiKey(db, apiKeyToken) : null;
        if (found) rememberKey(hash, found);
      }
      if (!found) {
        recordBadKey(client);
        return next(new HttpError(401, 'Invalid, expired or revoked API key.', { code: 'invalid_api_key' }));
      }
      req.user = found.user;
      req.apiKey = found.apiKey;
      req.authMethod = 'api_key';
      return next();
    }

    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const user = await userForSession(db, token);
      if (user) {
        req.user = user;
        req.authMethod = 'session';
        return next();
      }
    }

    if (opts.demoMode) {
      const id = req.header(DEMO_USER_HEADER);
      // Only the seeded, non-admin demo personas can be assumed — never a real account or an admin —
      // and a private world's personas only with that world's secret.
      const world = id ? worldOf(id) : null;
      const allowed = !!id && (world ? demoRoleOf(id) !== null && demoRoleOf(id) !== 'admin' && (await verifyDemoWorld(db, req.header(DEMO_WORLD_HEADER))) === world : DEMO_PERSONAS.has(id));
      if (id && allowed) {
        const user = await db.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, role: true } });
        if (user) {
          req.user = user as AuthUser;
          req.authMethod = 'demo';
        }
      }
    }
    next();
  };
}

/**
 * CSRF defence for cookie sessions: a state-changing request must come from
 * one of our own origins. API-key requests carry no ambient credentials and
 * are exempt.
 */
export function originCheck(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, _res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.authMethod === 'api_key') return next();
    const origin = req.header('origin');
    if (origin && !allowed.has(origin)) return next(new HttpError(403, 'Request origin not allowed.'));
    // Browsers that omit Origin still send Sec-Fetch-Site: refuse anything cross-site.
    const site = req.header('sec-fetch-site');
    if (!origin && site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
      return next(new HttpError(403, 'Cross-site request refused.'));
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in.'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, `This action requires role: ${roles.join(' or ')}.`));
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'Please sign in.');
  return req.user;
}
