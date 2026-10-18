import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db';
import { userForApiKey, userForSession, type AuthUser, type Role } from '../modules/auth/auth.service';
import { HttpError } from './errors';

export type { Role };
export type DemoUser = AuthUser;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      authMethod?: 'session' | 'api_key' | 'demo';
    }
  }
}

export const DEMO_USER_HEADER = 'x-demo-user';
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
      const user = await userForApiKey(db, auth.slice(7).trim());
      if (!user) return next(new HttpError(401, 'Invalid or revoked API key.'));
      req.user = user;
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
      if (id) {
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
