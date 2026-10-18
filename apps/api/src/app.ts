import cors from 'cors';
import express from 'express';
import type { Db } from './db';
import type { PayPalGateway } from './integrations/paypal/gateway';
import type { SigningKeys } from './modules/audit/signing';
import type { ReportWriter } from './modules/generation/writers';
import { demoAuth } from './http/demo-auth';
import { errorHandler, HttpError } from './http/errors';
import { buildRoutes } from './routes/builds';
import { commerceRoutes, webhookRoute } from './routes/commerce';
import { systemRoutes } from './routes/system';

export interface AppDeps {
  db: Db;
  /** Lazily resolved so the API still serves read-only pages without PayPal configured. */
  paypal: () => PayPalGateway;
  signingKeys: () => SigningKeys;
  writer: () => ReportWriter;
  config: {
    appBaseUrl: string;
    corsOrigins: string[];
    paypalClientId: string | null;
    paypalWebhookId: string | undefined;
    vertexReady: boolean;
  };
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(cors({ origin: deps.config.corsOrigins }));

  // Webhook signature verification needs the exact raw bytes, so this route
  // is mounted before the JSON body parser.
  app.post('/api/webhooks/paypal', express.raw({ type: '*/*', limit: '1mb' }), webhookRoute(deps));

  app.use(express.json({ limit: '1mb' }));
  app.use(demoAuth(deps.db));

  app.use('/api', systemRoutes(deps));
  app.use('/api', buildRoutes(deps));
  app.use('/api', commerceRoutes(deps));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use(errorHandler);
  return app;
}
