import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type { Db } from './db';
import type { PayPalGateway } from './integrations/paypal/gateway';
import type { SigningKeys } from './modules/audit/signing';
import type { ReportWriter } from './modules/generation/writers';
import type { AgentPlanner } from './modules/agent/planners';
import { authenticate, originCheck } from './http/auth';
import { errorHandler, HttpError } from './http/errors';
import { httpLogger } from './http/logger';
import { agentRoutes } from './routes/agent';
import { authRoutes } from './routes/auth';
import { buildRoutes } from './routes/builds';
import { commerceRoutes, webhookRoute } from './routes/commerce';
import { licensingRoutes } from './routes/licensing';
import { systemRoutes } from './routes/system';

export interface AppDeps {
  db: Db;
  /** Lazily resolved so the API still serves read-only pages without PayPal configured. */
  paypal: () => PayPalGateway;
  signingKeys: () => SigningKeys;
  writer: () => ReportWriter;
  planner: () => AgentPlanner;
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
  };
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(httpLogger);
  // A JSON API: no HTML is served, so lock everything down.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cors({ origin: deps.config.corsOrigins, credentials: true }));

  // Webhook signature verification needs the exact raw bytes, so this route is
  // mounted before the JSON body parser and outside the general rate limit.
  app.post('/api/webhooks/paypal', express.raw({ type: '*/*', limit: '1mb' }), webhookRoute(deps));

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: deps.config.rateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.path === '/health' || req.path === '/ready',
      message: { error: 'Too many requests. Please slow down.' },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(authenticate(deps.db, { demoMode: deps.config.demoMode }));
  app.use(originCheck([...deps.config.corsOrigins, deps.config.appBaseUrl]));

  app.use('/api', systemRoutes(deps));
  app.use('/api', authRoutes(deps));
  app.use('/api', buildRoutes(deps));
  app.use('/api', commerceRoutes(deps));
  app.use('/api', agentRoutes(deps));
  app.use('/api', licensingRoutes(deps));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use(errorHandler);
  return app;
}
