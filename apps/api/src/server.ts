import { createApp } from './app';
import { paypalEnv, serverEnv, signingEnv } from './config/env';
import { db } from './db';
import { PayPalClient } from './integrations/paypal/client';
import { loadSigningKeys, type SigningKeys } from './modules/audit/signing';
import { pickWriter } from './modules/generation/writers';
import { pickPlanner } from './modules/agent/planners';
import { HttpError } from './http/errors';

const env = serverEnv();

let paypal: PayPalClient | null = null;
let keys: SigningKeys | null = null;
const paypalConfigured = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

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
    corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    paypalClientId: paypalConfigured ? paypalEnv().PAYPAL_CLIENT_ID : null,
    paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
    vertexReady: Boolean(process.env.GOOGLE_CLOUD_PROJECT && process.env.VERTEX_MODEL),
  },
});

app.listen(env.PORT, () => {
  console.log(`TracePay API listening on :${env.PORT} (generation: ${pickWriter().name}, agent: ${pickPlanner().name}, paypal: ${paypalConfigured ? 'sandbox' : 'not configured'})`);
});
