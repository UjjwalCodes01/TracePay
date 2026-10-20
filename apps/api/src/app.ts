import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Db } from './db';
import type { PayPalGateway } from './integrations/paypal/gateway';
import type { SigningKeys } from './modules/audit/signing';
import type { ReportWriter } from './modules/generation/writers';
import type { AgentPlanner } from './modules/agent/planners';
import { authenticate, bearerToken, isPlatformApiPath, originCheck, WELL_FORMED_KEY } from './http/auth';
import { errorHandler, HttpError } from './http/errors';
import { httpLogger } from './http/logger';
import { agentRoutes } from './routes/agent';
import { authRoutes } from './routes/auth';
import { buildRoutes } from './routes/builds';
import { commerceRoutes, webhookRoute } from './routes/commerce';
import { licensingRoutes } from './routes/licensing';
import { systemRoutes } from './routes/system';
import { platformApi } from './platform-api';
import { v1ErrorHandler } from './platform-api/framework';
import type { WebhookDeps } from './modules/platform/webhooks';

export interface AppDeps {
  db: Db;
  /** Lazily resolved so the API still serves read-only pages without PayPal configured. */
  paypal: () => PayPalGateway;
  signingKeys: () => SigningKeys;
  writer: () => ReportWriter;
  planner: () => AgentPlanner;
  /** Outbound webhooks (endpoint management and deliveries). */
  webhooks: () => WebhookDeps;
  /** Called for every request from a signed-in caller (wakes background work). */
  onActivity?: () => void;
  config: {
    appBaseUrl: string;
    corsOrigins: string[];
    paypalClientId: string | null;
    paypalWebhookId: string | undefined;
    vertexReady: boolean;
    /** Enables the X-Demo-User role switcher and demo reset. Off in production. */
    demoMode: boolean;
    cookieSecure: boolean;
    /** Requests per minute per IP across the API. */
    rateLimitPerMinute: number;
    /** Sign-up / log-in attempts per 15 minutes per IP. */
    authRateLimit: number;
    webhookRateLimitPerMinute: number;
    trustProxyHops: number;
    /**
     * A header set by the platform's edge that carries the visitor's address and can't
     * be supplied by clients (Render: Cloudflare's cf-connecting-ip). When set, it is
     * the client IP for rate limits and logs instead of counting proxy hops.
     */
    clientIpHeader?: string;
    /**
     * Shared secret the web app's proxy (Vercel) attaches to the /api requests it
     * forwards. When it matches, the visitor IP Vercel reports is trusted, so people
     * using the website get per-visitor rate limits instead of per-Vercel-address ones.
     */
    trustedProxySecret?: string;
    /** Public base URL of this API, for the OpenAPI `servers` entry. */
    apiBaseUrl: string;
    /** Platform API requests per minute per API key (or per signed-in user). */
    apiRateLimitPerMinute: number;
    /** Check every platform API response against its documented schema (tests). */
    validateResponses?: boolean;
  };
}

export const PROXY_SECRET_HEADER = 'x-tracepay-proxy-secret';
const isPlatformApi = (req: express.Request) => isPlatformApiPath(req.originalUrl);
/** A request carrying a well-formed platform API key: limited per key (and guarded against guessing) instead of per IP. */
const carriesApiKey = (req: express.Request) => isPlatformApiPath(req.originalUrl) && WELL_FORMED_KEY.test(bearerToken(req) ?? '');

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Number of proxies in front of the API. Getting it wrong makes users share rate
  // limits (too few hops) or lets clients forge their address (too many). Platforms
  // whose proxy chain isn't fixed should use clientIpHeader instead.
  app.set('trust proxy', deps.config.trustProxyHops);
  const ipHeader = deps.config.clientIpHeader?.trim().toLowerCase();
  if (ipHeader) {
    app.use((req, _res, next) => {
      const value = req.headers[ipHeader];
      const ip = typeof value === 'string' ? value.trim() : '';
      // Shadow Express's req.ip getter: rate limiters and logs all read req.ip.
      if (isIP(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
      next();
    });
  }

  // Requests forwarded by our own web proxy carry the shared secret; only then is the
  // visitor address it reports believed (Vercel overwrites client-supplied values).
  // The secret header is removed before anything else (logs included) sees it.
  const proxySecret = deps.config.trustedProxySecret ? Buffer.from(deps.config.trustedProxySecret) : null;
  app.use((req, _res, next) => {
    const presented = req.headers[PROXY_SECRET_HEADER];
    delete req.headers[PROXY_SECRET_HEADER];
    if (proxySecret && typeof presented === 'string') {
      const got = Buffer.from(presented);
      if (got.length === proxySecret.length && timingSafeEqual(got, proxySecret)) {
        const reported = req.headers['x-vercel-forwarded-for'] ?? req.headers['x-real-ip'];
        const ip = (Array.isArray(reported) ? reported[0] : reported)?.split(',')[0]?.trim() ?? '';
        if (isIP(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
      }
    }
    next();
  });

  app.use(httpLogger);
  // A JSON API: no HTML is served, so lock everything down.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cors({ origin: deps.config.corsOrigins, credentials: true }));

  // Webhook signature verification needs the exact raw bytes, so this route is
  // mounted before the JSON body parser and outside the general rate limit.
  app.post(
    '/api/webhooks/paypal',
    rateLimit({ windowMs: 60_000, limit: deps.config.webhookRateLimitPerMinute, standardHeaders: 'draft-8', legacyHeaders: false }),
    express.raw({ type: '*/*', limit: '256kb' }),
    webhookRoute(deps),
  );

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: deps.config.rateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // API-key traffic is limited per key inside /api/v1 instead (integrations often share an IP).
      skip: (req) => req.path === '/health' || req.path === '/ready' || carriesApiKey(req),
      handler: (_req, _res, next) => next(new HttpError(429, 'Too many requests. Please slow down.', { code: 'rate_limited' }, 60)),
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(authenticate(deps.db, { demoMode: deps.config.demoMode }));
  app.use(originCheck([...deps.config.corsOrigins, deps.config.appBaseUrl]));
  if (deps.onActivity) {
    const onActivity = deps.onActivity;
    app.use((req, _res, next) => {
      if (req.user) onActivity();
      next();
    });
  }

  app.use(
    '/api/v1',
    platformApi(deps, { serverUrl: `${deps.config.apiBaseUrl.replace(/\/$/, '')}/api/v1`, rateLimitPerMinute: deps.config.apiRateLimitPerMinute, validateResponses: deps.config.validateResponses ?? false }),
  );
  app.use('/api', systemRoutes(deps));
  app.use('/api', authRoutes(deps));
  app.use('/api', buildRoutes(deps));
  app.use('/api', commerceRoutes(deps));
  app.use('/api', agentRoutes(deps));
  app.use('/api', licensingRoutes(deps));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
  // Errors raised before the platform router (bad key, malformed JSON, IP limits) still get its error format.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) =>
    isPlatformApi(req) ? v1ErrorHandler(err, req, res, next) : errorHandler(err, req, res, next),
  );
  return app;
}
