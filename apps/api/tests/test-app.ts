import { createApp, type AppDeps } from '../src/app';
import { db } from '../src/db';
import type { PayPalGateway } from '../src/integrations/paypal/gateway';
import { RuleBasedPlanner } from '../src/modules/agent/planners';
import { generateSigningKeys, loadSigningKeys } from '../src/modules/audit/signing';
import { FixtureReportWriter } from '../src/modules/generation/writers';
import { SecretBox } from '../src/modules/platform/webhook-crypto';
import type { WebhookDeps } from '../src/modules/platform/webhooks';

const keys = loadSigningKeys(generateSigningKeys().privateKeyB64);
export const TEST_ORIGIN = 'http://localhost:5173';

export const testWebhookBox = SecretBox.forTests();
/** Webhook deps for tests: private/loopback receivers allowed unless a test overrides the policy. */
export function testWebhookDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return { db: db(), box: testWebhookBox, policy: { allowHttp: true, allowPrivate: true }, timeoutMs: 2_000, ...overrides };
}

export function testApp(paypal: PayPalGateway, config: Partial<AppDeps['config']> = {}, webhookOverrides: Partial<WebhookDeps> = {}) {
  return createApp({
    db: db(),
    paypal: () => paypal,
    signingKeys: () => keys,
    writer: () => new FixtureReportWriter(),
    planner: () => new RuleBasedPlanner(),
    webhooks: () => testWebhookDeps(webhookOverrides),
    config: {
      appBaseUrl: TEST_ORIGIN,
      corsOrigins: [TEST_ORIGIN],
      paypalClientId: 'test-client',
      paypalWebhookId: 'WH-ID',
      vertexReady: false,
      demoMode: true,
      cookieSecure: false,
      rateLimitPerMinute: 10_000,
      authRateLimit: 1_000,
      webhookRateLimitPerMinute: 10_000,
      trustProxyHops: 1,
      apiBaseUrl: 'http://localhost:4000',
      apiRateLimitPerMinute: 10_000,
      // Every platform API response in every test must match its documented schema.
      validateResponses: true,
      ...config,
    },
  });
}
