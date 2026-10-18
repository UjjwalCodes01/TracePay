import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { currentUser, readCookie, requireRole, SESSION_COOKIE } from '../http/auth';
import { HttpError } from '../http/errors';
import { AuthError, createApiKey, createSession, destroySession, logIn, signUp } from '../modules/auth/auth.service';

const SignUpBody = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  name: z.string().trim().min(2).max(120),
  role: z.enum(['publisher', 'contributor', 'buyer']),
  paypalEmail: z.email().max(254).optional().nullable(),
});

const LogInBody = z.object({ email: z.string().min(3).max(254), password: z.string().min(1).max(200) });

export function authRoutes({ db, config }: AppDeps) {
  const r = Router();

  // Brute-force protection on credential endpoints.
  const credentialLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in a few minutes.' },
  });

  const setSessionCookie = (res: Response, token: string, expiresAt: Date) =>
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });

  const mapAuthError = (err: unknown): never => {
    if (err instanceof AuthError) throw new HttpError(err.code === 'email_taken' ? 409 : 401, err.message);
    throw err;
  };

  r.post('/auth/signup', credentialLimiter, async (req, res) => {
    const body = SignUpBody.parse(req.body);
    const user = await signUp(db, body).catch(mapAuthError);
    const { token, expiresAt } = await createSession(db, user.id, req.header('user-agent'));
    setSessionCookie(res, token, expiresAt);
    res.status(201).json({ user });
  });

  r.post('/auth/login', credentialLimiter, async (req, res) => {
    const body = LogInBody.parse(req.body);
    const user = await logIn(db, body.email, body.password).catch(mapAuthError);
    const { token, expiresAt } = await createSession(db, user.id, req.header('user-agent'));
    setSessionCookie(res, token, expiresAt);
    res.json({ user });
  });

  r.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await destroySession(db, token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.json({ user: currentUser(req), authMethod: req.authMethod });
  });

  // ---- API keys for platform integrations --------------------------------------

  r.get('/auth/api-keys', requireRole('publisher', 'admin'), async (req, res) => {
    const keys = await db.apiKey.findMany({
      where: { userId: currentUser(req).id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    });
    res.json({ keys });
  });

  r.post('/auth/api-keys', requireRole('publisher', 'admin'), async (req, res) => {
    if (req.authMethod === 'api_key') throw new HttpError(403, 'API keys cannot create other API keys.');
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const created = await createApiKey(db, currentUser(req).id, name);
    // The full key is shown exactly once.
    res.status(201).json(created);
  });

  r.delete('/auth/api-keys/:id', requireRole('publisher', 'admin'), async (req, res) => {
    const id = z.string().min(1).max(64).parse(req.params.id);
    const result = await db.apiKey.updateMany({ where: { id, userId: currentUser(req).id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (result.count === 0) throw new HttpError(404, 'API key not found.');
    res.json({ ok: true });
  });

  return r;
}
