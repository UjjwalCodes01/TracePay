import { createApp } from './app';
import { aiReady, answersEnv, paypalEnv, productionConfigProblems, serverEnv, signingEnv } from './config/env';
import { db } from './db';
import { HttpError } from './http/errors';
import { logger } from './http/logger';
import { PayPalClient } from './integrations/paypal/client';
import { pickPlanner } from './modules/agent/planners';
import { loadSigningKeys, type SigningKeys } from './modules/audit/signing';
import { pickAnswerWriter, pickWriter } from './modules/generation/writers';
import { recoverStaleWork, STALE_WORK_MS } from './modules/maintenance/recovery';
import { pruneRetention } from './modules/maintenance/retention';
import { ReconciliationWorker } from './modules/reconciliation/sync';
import { setReconcileListener } from './modules/reconciliation/schedule';
import { setOutboxListener } from './modules/platform/events';
import { pruneWebhookData, WebhookDispatcher, type WebhookDeps } from './modules/platform/webhooks';
import { SecretBox } from './modules/platform/webhook-crypto';
import { DEMO_USERS, WORLD_PREFIX } from './modules/demo/world';
import { closeLimitStore } from './http/rate-store';

const env = serverEnv();

// Fail fast on a misconfigured production deployment rather than at first use.
answersEnv();
if (env.NODE_ENV === 'production') {
  const problems = productionConfigProblems();
  if (problems.length) {
    logger.fatal({ problems }, 'refusing to start: production configuration is incomplete');
    throw new Error(`Production configuration is incomplete:\n- ${problems.join('\n- ')}`);
  }
  signingEnv();
  if (env.DEMO_MODE) logger.warn('DEMO_MODE is ON in production: anyone can act as the demo personas. Turn it off before real users arrive.');
  if (!process.env.WEBHOOK_SECRET_KEY) logger.warn('WEBHOOK_SECRET_KEY is not set: webhook secrets are encrypted with a key derived from the audit signing key.');
  if (!process.env.REDIS_URL) logger.warn('REDIS_URL is not set: rate limits are counted per instance.');
}

let paypal: PayPalClient | null = null;
let keys: SigningKeys | null = null;
const paypalConfigured = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

// Outbound webhooks. Signing secrets are encrypted at rest with WEBHOOK_SECRET_KEY
// (or a key derived from the audit signing key when it isn't set).
let webhookDeps: WebhookDeps | null = null;
const webhooks = (): WebhookDeps =>
  (webhookDeps ??= {
    db: db(),
    box: SecretBox.fromEnv(process.env.WEBHOOK_SECRET_KEY, signingEnv().AUDIT_SIGNING_PRIVATE_KEY, process.env.WEBHOOK_SECRET_KEY_PREVIOUS),
    // Private/loopback targets and plain http are for local development only.
    policy: { allowHttp: env.WEBHOOK_ALLOW_PRIVATE_TARGETS, allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_TARGETS },
  });
if (env.WEBHOOK_ALLOW_PRIVATE_TARGETS && env.NODE_ENV === 'production') {
  logger.warn('WEBHOOK_ALLOW_PRIVATE_TARGETS is ON in production: webhooks may reach private networks. Turn it off.');
}

// Activity from signed-in callers (see app.ts): keeps the maintenance sweep and
// webhook retries going while the API is in use.
let lastActivity = Date.now();
let dispatcherRef: { kick: (r: 'activity') => void } | null = null;
// Reconciliation with PayPal (Phase D): checks payouts and payments on a schedule,
// whether or not PayPal's webhooks arrive.
const reconciler = new ReconciliationWorker(() => (paypalConfigured ? { db: db(), paypal: (paypal ??= PayPalClient.fromEnv()) } : null));
setReconcileListener((at) => reconciler.scheduledFor(at));
const onActivity = () => {
  lastActivity = Date.now();
  dispatcherRef?.kick('activity');
  reconciler.kick();
};

const app = createApp({
  db: db(),
  paypal: () => {
    if (!paypalConfigured) throw new HttpError(503, 'PayPal sandbox credentials are not configured on the server.');
    return (paypal ??= PayPalClient.fromEnv());
  },
  signingKeys: () => (keys ??= loadSigningKeys(signingEnv().AUDIT_SIGNING_PRIVATE_KEY)),
  writer: () => pickWriter(),
  answerWriter: () => pickAnswerWriter(),
  planner: () => pickPlanner(),
  webhooks,
  onActivity,
  config: {
    appBaseUrl: env.APP_BASE_URL,
    corsOrigins,
    paypalClientId: paypalConfigured ? paypalEnv().PAYPAL_CLIENT_ID : null,
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
    vertexReady: aiReady(),
    demoMode: env.DEMO_MODE,
    demoSharedBuyer: env.DEMO_MODE && env.DEMO_SHARED_BUYER,
    cookieSecure: env.NODE_ENV === 'production',
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    authRateLimit: env.AUTH_RATE_LIMIT,
    webhookRateLimitPerMinute: env.WEBHOOK_RATE_LIMIT_PER_MINUTE,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    clientIpHeader: env.CLIENT_IP_HEADER || undefined,
    trustedProxySecret: env.TRUSTED_PROXY_SECRET || undefined,
    apiBaseUrl: env.API_BASE_URL,
    apiRateLimitPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
  },
});

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, generation: pickWriter().name, agent: pickPlanner().name, paypal: paypalConfigured ? 'sandbox' : 'not configured', demoMode: env.DEMO_MODE },
    'TracePay API listening',
  );
});

// Recover work interrupted by a previous restart, then keep sweeping periodically.
// Work only goes stale if it was started recently, so an idle API skips the sweep:
// that lets a serverless database (Neon) suspend instead of being woken every few
// minutes. Health checks don't count as activity.
const SWEEP_EVERY_MS = 5 * 60_000;
// Webhook deliveries run in the background: woken by new events and by signed-in
// API activity, otherwise asleep until the next scheduled retry (so an idle API —
// or one only hit by scanners — lets Neon suspend). A first pass runs at boot so
// retries that were pending before a restart aren't stranded.
const dispatcher = new WebhookDispatcher(webhooks);
dispatcherRef = dispatcher;
setOutboxListener(() => dispatcher.kick('event'));
dispatcher.kick('activity');
reconciler.kick();
const sweep = () =>
  Promise.all([
    recoverStaleWork(db()).then((r) => (r.agentRuns || r.builds || r.answers) && logger.warn(r, 'recovered interrupted work')),
    pruneWebhookData(db()).then((r) => (r.events || r.idempotencyKeys) && logger.info(r, 'pruned old platform API data')),
    pruneRetention(db()).then((r) => (r.sessions || r.webhookPayloads) && logger.info(r, 'retention: pruned expired personal data')),
  ]).catch((err) => logger.error({ err }, 'maintenance sweep failed'));
void sweep();

// Keys minted by anonymous demo visitors must not outlive demo mode.
if (!env.DEMO_MODE) {
  void db()
    .apiKey.updateMany({ where: { OR: [{ userId: { in: DEMO_USERS.map((u) => u.id) } }, { userId: { startsWith: WORLD_PREFIX } }], revokedAt: null }, data: { revokedAt: new Date() } })
    .then((r) => r.count && logger.warn({ revoked: r.count }, 'revoked API keys of demo personas (DEMO_MODE is off)'))
    .catch((err) => logger.error({ err }, 'could not revoke demo API keys'));
}
setInterval(() => {
  if (Date.now() - lastActivity <= STALE_WORK_MS + SWEEP_EVERY_MS) void sweep();
}, SWEEP_EVERY_MS).unref();

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      // Let in-flight webhook sends finish and be recorded (bounded by the hard exit below).
      await Promise.all([dispatcher.stop().catch(() => undefined), reconciler.stop().catch(() => undefined)]);
      await Promise.all([db().$disconnect().catch(() => undefined), closeLimitStore()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
