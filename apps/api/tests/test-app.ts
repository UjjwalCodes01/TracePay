import { createApp, type AppDeps } from '../src/app';
import { db } from '../src/db';
import type { PayPalGateway } from '../src/integrations/paypal/gateway';
import { RuleBasedPlanner } from '../src/modules/agent/planners';
import { generateSigningKeys, loadSigningKeys } from '../src/modules/audit/signing';
import { FixtureReportWriter } from '../src/modules/generation/writers';

const keys = loadSigningKeys(generateSigningKeys().privateKeyB64);
export const TEST_ORIGIN = 'http://localhost:5173';

export function testApp(paypal: PayPalGateway, config: Partial<AppDeps['config']> = {}) {
  return createApp({
    db: db(),
    paypal: () => paypal,
    signingKeys: () => keys,
    writer: () => new FixtureReportWriter(),
    planner: () => new RuleBasedPlanner(),
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
      ...config,
    },
  });
}
