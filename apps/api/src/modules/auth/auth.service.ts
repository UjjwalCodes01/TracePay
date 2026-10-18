import type { Db } from '../../db';
import { DUMMY_PASSWORD_HASH, hashPassword, randomToken, sha256, verifyPassword } from './crypto';

export type Role = 'publisher' | 'contributor' | 'buyer' | 'admin';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export class AuthError extends Error {
  constructor(message: string, readonly code: 'invalid_credentials' | 'email_taken' | 'invalid') {
    super(message);
    this.name = 'AuthError';
  }
}

const SESSION_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 14);
const USER_SELECT = { id: true, name: true, email: true, role: true } as const;
export const API_KEY_PREFIX = 'tp_';

export async function signUp(
  db: Db,
  input: { email: string; password: string; name: string; role: Exclude<Role, 'admin'>; paypalEmail?: string | null },
): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new AuthError('An account with this email already exists.', 'email_taken');
  const user = await db.user.create({
    data: {
      email,
      name: input.name.trim(),
      role: input.role,
      paypalEmail: input.paypalEmail?.trim().toLowerCase() || null,
      passwordHash: await hashPassword(input.password),
    },
    select: USER_SELECT,
  });
  return user as AuthUser;
}

export async function logIn(db: Db, emailInput: string, password: string): Promise<AuthUser> {
  const email = emailInput.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email }, select: { ...USER_SELECT, passwordHash: true } });
  // Always run scrypt so response time doesn't reveal whether the email exists.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user?.passwordHash || !ok) throw new AuthError('Email or password is incorrect.', 'invalid_credentials');
  const { passwordHash: _ignored, ...publicUser } = user;
  return publicUser as AuthUser;
}

/** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(db: Db, userId: string, userAgent?: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.session.create({ data: { id: sha256(token), userId, expiresAt, userAgent: userAgent?.slice(0, 300) } });
  return { token, expiresAt };
}

export async function userForSession(db: Db, token: string): Promise<AuthUser | null> {
  const session = await db.session.findUnique({ where: { id: sha256(token) }, include: { user: { select: USER_SELECT } } });
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  // Touch at most once a minute to keep writes cheap.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return session.user as AuthUser;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.session.deleteMany({ where: { id: sha256(token) } });
}

// ---- API keys --------------------------------------------------------------------

export async function createApiKey(db: Db, userId: string, name: string): Promise<{ id: string; key: string; prefix: string }> {
  const key = `${API_KEY_PREFIX}${randomToken(24)}`;
  const prefix = key.slice(0, 10);
  const row = await db.apiKey.create({ data: { userId, name: name.trim().slice(0, 80), prefix, keyHash: sha256(key) } });
  return { id: row.id, key, prefix };
}

export async function userForApiKey(db: Db, key: string): Promise<AuthUser | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;
  const row = await db.apiKey.findUnique({ where: { keyHash: sha256(key) }, include: { user: { select: USER_SELECT } } });
  if (!row || row.revokedAt) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return row.user as AuthUser;
}
