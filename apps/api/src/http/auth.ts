import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db';
import { userForApiKey, userForSession, type ApiKeyInfo, type AuthUser, type Role } from '../modules/auth/auth.service';
import { DEMO_USERS } from '../modules/demo/world';
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

/**
 * Brute-force guard for API keys: rejected keys are counted per client IP, and
 * once an address has too many it gets 429 for further INVALID keys. Valid keys
 * are never blocked, so an integration sharing an IP with a guesser keeps working.
 * Per process (each instance counts its own).
 */
const BAD_KEY_LIMIT = 30;
const BAD_KEY_WINDOW_MS = 10 * 60_000;
const badKeys = new Map<string, { count: number; resetAt: number }>();
function tooManyBadKeys(ip: string, now = Date.now()): boolean {
  const entry = badKeys.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (badKeys.size > 10_000) for (const [k, v] of badKeys) if (v.resetAt <= now) badKeys.delete(k);
    badKeys.set(ip, { count: 1, resetAt: now + BAD_KEY_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > BAD_KEY_LIMIT;
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
    const auth = req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
      const found = await userForApiKey(db, auth.slice(7).trim());
      if (!found) {
        if (tooManyBadKeys(req.ip ?? 'unknown')) {
          return next(new HttpError(429, 'Too many invalid API keys from this address. Try again later.', { code: 'rate_limited' }, Math.ceil(BAD_KEY_WINDOW_MS / 1000)));
        }
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
      // Only the seeded, non-admin demo personas can be assumed — never a real account or an admin.
      if (id && DEMO_PERSONAS.has(id)) {
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
