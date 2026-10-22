import { z } from 'zod';

/**
 * Each integration reads its own slice of the environment lazily, so the
 * unit tests and smoke scripts only need the variables they actually touch.
 */

function parse<T extends z.ZodType>(schema: T, label: string): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid ${label} configuration:\n${missing}\nSee .env.example.`);
  }
  return result.data;
}

const nonEmpty = z.string().trim().min(1);
/** An optional whole number; unset or empty (as in a copied .env.example) means "use the default". */
const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

export const serverEnv = () =>
  parse(
    z.object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      PORT: z.coerce.number().int().default(4000),
      /** The hackathon role switcher. Never enable for real users. */
      DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
      RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
      AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
      WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
      /** Proxies in front of the API; ignored for client IPs when CLIENT_IP_HEADER is set. */
      TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
      /**
       * Header carrying the visitor's IP, set by the platform edge (never by clients).
       * On Render that is Cloudflare's cf-connecting-ip: Render's own proxy chain has
       * several hops, so counting hops made every visitor share one rate limit.
       * Defaults to it when running on Render (which sets RENDER=true).
       */
      CLIENT_IP_HEADER: z.string().trim().default(process.env.RENDER === 'true' ? 'cf-connecting-ip' : ''),
      /** Shared with the web app's proxy (Vercel env TRACEPAY_PROXY_SECRET): trust the visitor IP it forwards. 32+ characters. */
      TRUSTED_PROXY_SECRET: z.string().trim().refine((v) => v === '' || v.length >= 32, 'Use at least 32 characters.').default(''),
      /** Runtime connection. On Neon, use the pooled ("-pooler") connection string. */
      DATABASE_URL: nonEmpty,
      DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
      APP_BASE_URL: z.url().default('http://localhost:5173'),
      /** Platform API (/api/v1) requests per minute per API key. */
      API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
      /** Let webhooks reach http:// and private/loopback addresses. Local development ONLY. */
      WEBHOOK_ALLOW_PRIVATE_TARGETS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
      API_BASE_URL: z.url().default('http://localhost:4000'),
      CORS_ORIGINS: z.string().default('http://localhost:5173'),
    }),
    'server',
  );

export const paypalEnv = () =>
  parse(
    z.object({
      // Sandbox only. Live credentials are deliberately not supported.
      PAYPAL_ENV: z.literal('sandbox').default('sandbox'),
      PAYPAL_CLIENT_ID: nonEmpty,
      PAYPAL_CLIENT_SECRET: nonEmpty,
      PAYPAL_WEBHOOK_ID: z.string().optional(),
    }),
    'PayPal',
  );

/**
 * The AI model TracePay uses (Gemini), from either of two places:
 *  - Vertex AI (Google Cloud): GOOGLE_CLOUD_PROJECT + VERTEX_MODEL, with gcloud ADC
 *    locally or GOOGLE_SERVICE_ACCOUNT_JSON on a server;
 *  - the Gemini API (Google AI Studio): GEMINI_API_KEY, optionally GEMINI_MODEL.
 * Vertex wins when both are set. Null when neither is: the labelled non-AI fallbacks run.
 */
export type AiConfig =
  | { provider: 'vertex'; project: string; location: string; model: string; serviceAccountJson?: string }
  | { provider: 'gemini-api'; apiKey: string; model: string };

export function aiConfig(): AiConfig | null {
  const e = process.env;
  if (e.GOOGLE_CLOUD_PROJECT?.trim() && e.VERTEX_MODEL?.trim()) {
    return {
      provider: 'vertex',
      project: e.GOOGLE_CLOUD_PROJECT.trim(),
      location: e.GOOGLE_CLOUD_LOCATION?.trim() || 'us-central1',
      model: e.VERTEX_MODEL.trim(),
      serviceAccountJson: e.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || undefined,
    };
  }
  if (e.GEMINI_API_KEY?.trim()) {
    return { provider: 'gemini-api', apiKey: e.GEMINI_API_KEY.trim(), model: e.GEMINI_MODEL?.trim() || 'gemini-flash-latest' };
  }
  return null;
}

export const aiReady = (): boolean => aiConfig() !== null;

/**
 * Free text telling demo visitors which PayPal sandbox buyer account to pay with
 * (e.g. "judge@example.com / password"). Sandbox-only credentials, shown only in
 * demo mode; never put real account details here.
 */
export const sandboxBuyerHint = (): string | null => process.env.PAYPAL_SANDBOX_BUYER_HINT?.trim().slice(0, 300) || null;

/** Pay-per-citation pricing and payout rules (all optional; defaults documented in .env.example). */
export const answersEnv = () =>
  parse(
    z.object({
      /** The library's fee per answered question, in cents. */
      ANSWER_FEE_CENTS: optionalInt(0, 100),
      /** Smallest royalty total worth one PayPal payout, in cents. */
      ROYALTY_PAYOUT_MIN_CENTS: optionalInt(1, 100_000),
      /** Days before an earned credit can be paid out (refunds and chargebacks land first). */
      CREDIT_CLEARING_DAYS: optionalInt(0, 180),
    }),
    'answers',
  );

/**
 * Problems that make a production deployment unsafe or broken. The server refuses to
 * start with any of them (it would otherwise fail later, at a customer's first payment).
 */
export function productionConfigProblems(e: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const local = (v: string | undefined) => !v || /localhost|127\.0\.0\.1|\[::1\]/.test(v);
  if (local(e.APP_BASE_URL)) problems.push('APP_BASE_URL must be the public web address (PayPal sends buyers back there).');
  if (local(e.API_BASE_URL)) problems.push('API_BASE_URL must be the public API address.');
  if (local(e.CORS_ORIGINS)) problems.push('CORS_ORIGINS must list the public web origin(s).');
  if (!e.PAYPAL_CLIENT_ID?.trim() || !e.PAYPAL_CLIENT_SECRET?.trim()) problems.push('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required.');
  if (!e.PAYPAL_WEBHOOK_ID?.trim()) problems.push('PAYPAL_WEBHOOK_ID is required: without it every PayPal webhook is rejected.');
  if (!e.AUDIT_SIGNING_PRIVATE_KEY?.trim()) problems.push('AUDIT_SIGNING_PRIVATE_KEY is required (npm run keys:generate -w @tracepay/api).');
  return problems;
}

export const signingEnv = () =>
  parse(z.object({ AUDIT_SIGNING_PRIVATE_KEY: nonEmpty }), 'audit signing');
