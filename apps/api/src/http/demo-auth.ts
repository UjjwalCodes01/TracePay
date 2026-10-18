import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db';
import { HttpError } from './errors';

export type Role = 'publisher' | 'contributor' | 'buyer' | 'admin';

export interface DemoUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: DemoUser;
    }
  }
}

export const DEMO_USER_HEADER = 'x-demo-user';

/**
 * DEMO-ONLY authentication: the client names one of the seeded users in the
 * `X-Demo-User` header (the UI's role switcher). There are no passwords in
 * this prototype; a production deployment would replace this with real auth.
 */
export function demoAuth(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const id = req.header(DEMO_USER_HEADER);
    if (id) {
      const user = await db.user.findUnique({ where: { id }, select: { id: true, name: true, email: true, role: true } });
      if (user) req.user = user as DemoUser;
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Choose a demo user (X-Demo-User header).'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, `This action requires role: ${roles.join(' or ')}.`));
    next();
  };
}

export function currentUser(req: Request): DemoUser {
  if (!req.user) throw new HttpError(401, 'Choose a demo user (X-Demo-User header).');
  return req.user;
}
