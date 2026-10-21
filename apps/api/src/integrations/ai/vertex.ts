import { GoogleGenAI } from '@google/genai';
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

/**
 * Structured generation: the model must return JSON matching `schema`, and the
 * result is validated again with zod before anything downstream trusts it.
 */
export async function generateStructured<S extends z.ZodType>(args: {
  system: string;
  prompt: string;
  schema: S;
  temperature?: number;
}): Promise<{ data: z.infer<S>; model: string; usage: { inputTokens?: number; outputTokens?: number } }> {
  const { ai, model } = vertex();
  const response = await ai.models.generateContent({
    model,
    contents: args.prompt,
    config: {
      systemInstruction: args.system,
      temperature: args.temperature ?? 0.2,
      responseMimeType: 'application/json',
      responseJsonSchema: toJSONSchema(args.schema, { target: 'draft-7' }),
    },
  });
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
