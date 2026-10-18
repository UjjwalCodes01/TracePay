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

export const serverEnv = () =>
  parse(
    z.object({
      PORT: z.coerce.number().int().default(4000),
      DATABASE_URL: nonEmpty,
      APP_BASE_URL: z.url().default('http://localhost:5173'),
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

export const vertexEnv = () =>
  parse(
    z.object({
      GOOGLE_CLOUD_PROJECT: nonEmpty,
      GOOGLE_CLOUD_LOCATION: nonEmpty.default('us-central1'),
      VERTEX_MODEL: nonEmpty,
      /** Service-account JSON (raw or base64) for hosts without gcloud ADC, e.g. Render. */
      GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    }),
    'Vertex AI',
  );

export const signingEnv = () =>
  parse(z.object({ AUDIT_SIGNING_PRIVATE_KEY: nonEmpty }), 'audit signing');
