import { createApp } from './app';
import { paypalEnv, serverEnv, signingEnv } from './config/env';
import { db } from './db';
import { HttpError } from './http/errors';
import { logger } from './http/logger';
import { PayPalClient } from './integrations/paypal/client';
import { pickPlanner } from './modules/agent/planners';
import { loadSigningKeys, type SigningKeys } from './modules/audit/signing';
import { pickWriter } from './modules/generation/writers';

const env = serverEnv();

// Fail fast on a misconfigured production deployment rather than at first use.
if (env.NODE_ENV === 'production') {
  signingEnv();
  if (env.DEMO_MODE) logger.warn('DEMO_MODE is ON in production: the demo role switcher is enabled.');
}

let paypal: PayPalClient | null = null;
let keys: SigningKeys | null = null;
const paypalConfigured = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

const app = createApp({
  db: db(),
  paypal: () => {
    if (!paypalConfigured) throw new HttpError(503, 'PayPal sandbox credentials are not configured on the server.');
    return (paypal ??= PayPalClient.fromEnv());
  },
  signingKeys: () => (keys ??= loadSigningKeys(signingEnv().AUDIT_SIGNING_PRIVATE_KEY)),
  writer: () => pickWriter(),
  planner: () => pickPlanner(),
  config: {
    appBaseUrl: env.APP_BASE_URL,
    corsOrigins,
    paypalClientId: paypalConfigured ? paypalEnv().PAYPAL_CLIENT_ID : null,
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
    vertexReady: Boolean(process.env.GOOGLE_CLOUD_PROJECT && process.env.VERTEX_MODEL),
    demoMode: env.DEMO_MODE,
    cookieSecure: env.NODE_ENV === 'production',
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    authRateLimit: env.AUTH_RATE_LIMIT,
  },
});

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, generation: pickWriter().name, agent: pickPlanner().name, paypal: paypalConfigured ? 'sandbox' : 'not configured', demoMode: env.DEMO_MODE },
    'TracePay API listening',
  );
});

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await db().$disconnect().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
