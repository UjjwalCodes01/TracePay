import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { z } from 'zod';
import { toJSONSchema } from 'zod';
import { aiConfig } from '../../config/env';

let client: { ai: GoogleGenAI; model: string; provider: string } | null = null;

/**
 * The Gemini client: through Vertex AI (gcloud Application Default Credentials
 * locally, GOOGLE_SERVICE_ACCOUNT_JSON on a server) or through the Gemini API with
 * an API key from Google AI Studio. See aiConfig().
 */
export function vertex(): { ai: GoogleGenAI; model: string; provider: string } {
  if (client) return client;
  const cfg = aiConfig();
  if (!cfg) throw new Error('No AI model is configured (set GEMINI_API_KEY, or GOOGLE_CLOUD_PROJECT and VERTEX_MODEL).');
  if (cfg.provider === 'vertex') {
    const credentials = cfg.serviceAccountJson ? parseServiceAccount(cfg.serviceAccountJson) : undefined;
    client = {
      ai: new GoogleGenAI({
        vertexai: true,
        project: cfg.project,
        location: cfg.location,
        ...(credentials ? { googleAuthOptions: { credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] } } : {}),
      }),
      model: cfg.model,
      provider: 'Vertex AI',
    };
  } else {
    client = { ai: new GoogleGenAI({ apiKey: cfg.apiKey }), model: cfg.model, provider: 'Gemini API' };
  }
  return client;
}

function parseServiceAccount(value: string): Record<string, string> {
  const text = value.trim().startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
  return JSON.parse(text) as Record<string, string>;
}

/** Rate limits and overload (shared pay-as-you-go capacity can briefly run dry) are worth a short retry. */
const TRANSIENT = /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i;
export const isTransientModelError = (err: unknown) => {
  const status = (err as { status?: number }).status;
  return (typeof status === 'number' && (status === 429 || status >= 500)) || TRANSIENT.test((err as Error)?.message ?? '');
};
/** Waits between attempts (plus jitter); four attempts in all, about 8 s of waiting at most. */
export const MODEL_RETRY_DELAYS_MS = [1_000, 2_500, 4_500];

/** Calls the model, retrying transient failures (never invalid requests or bad replies). */
export async function withModelRetry<T>(call: () => Promise<T>, delays: readonly number[] = MODEL_RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= delays.length || !isTransientModelError(err)) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]! + Math.floor(Math.random() * 400)));
    }
  }
}

/**
 * Opens the connections to Google (TLS, service-account token, the model endpoints) right after
 * the server starts, so the first visitor after a cold start isn't the one who pays ~30 s for it.
 * Two tiny calls; failures are only logged.
 */
export async function warmUpAi(embeddingModel: string): Promise<number> {
  const started = Date.now();
  const { ai, model } = vertex();
  await Promise.all([
    ai.models.embedContent({ model: embeddingModel, contents: ['warm up'], config: { taskType: 'SEMANTIC_SIMILARITY' } }),
    ai.models.generateContent({
      model,
      contents: 'Reply with OK.',
      config: { maxOutputTokens: 64, httpOptions: { timeout: AI_TIMEOUT_MS }, ...(/^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } } : {}) },
    }),
  ]);
  return Date.now() - started;
}

/** Every model call gives up after this long. */
export const AI_TIMEOUT_MS = 60_000;
/** Generous (thinking models spend output tokens on reasoning) but bounded. */
export const AI_MAX_OUTPUT_TOKENS = 8192;

/**
 * The JSON schema the model is asked to follow. zod bounds integers by JavaScript's safe range
 * (±9007199254740991) and Vertex AI rejects those as an invalid argument (they constrain nothing);
 * it also rejects array limits above about 60. zod still enforces every limit on the reply.
 */
export function modelSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'maximum' || k === 'minimum') && typeof v === 'number' && Math.abs(v) >= Number.MAX_SAFE_INTEGER) continue;
      // Vertex also rejects large array limits (100 fails, 60 works); the reply is still checked with zod.
      if (k === 'maxItems' && typeof v === 'number' && v > 60) continue;
      out[k] = strip(v);
    }
    return out;
  };
  return strip(toJSONSchema(schema, { target: 'draft-7' })) as Record<string, unknown>;
}

/**
 * Structured generation: the model must return JSON matching `schema`, and the
 * result is validated again with zod before anything downstream trusts it.
 */
export async function generateStructured<S extends z.ZodType>(args: {
  system: string;
  prompt: string;
  schema: S;
  temperature?: number;
  /**
   * How much the model reasons before answering. Simple classifications (is this an instruction? does
   * this sentence use this passage?) need little, and answer in about a second instead of four.
   * Applied to Gemini 3 models only; older ones don't take the setting.
   */
  thinking?: 'minimal' | 'low';
  /** Another model than the configured one (the red team's attacker). */
  model?: string;
}): Promise<{ data: z.infer<S>; model: string; usage: { inputTokens?: number; outputTokens?: number } }> {
  const { ai } = vertex();
  const model = args.model ?? vertex().model;
  const thinking = args.thinking && /^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: args.thinking === 'minimal' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW } } : {};
  const response = await withModelRetry(() =>
    ai.models.generateContent({
      model,
      contents: args.prompt,
      config: {
        systemInstruction: args.system,
        temperature: args.temperature ?? 0.2,
        // Bounded in time and size: a hung or runaway call must not hold credit or a request open.
        httpOptions: { timeout: AI_TIMEOUT_MS },
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseJsonSchema: modelSchema(args.schema),
        ...thinking,
      },
    }),
  );
  const text = response.text;
  if (!text) throw new Error('The AI model returned an empty response.');
  const data = args.schema.parse(JSON.parse(text));
  return {
    data,
    model,
    usage: {
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
    },
  };
}
