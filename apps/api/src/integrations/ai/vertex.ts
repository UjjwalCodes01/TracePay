import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { toJSONSchema } from 'zod';
import { vertexEnv } from '../../config/env';

let client: { ai: GoogleGenAI; model: string } | null = null;

/**
 * Vertex AI (Gemini) client. Locally it uses gcloud Application Default
 * Credentials; on Render it uses GOOGLE_SERVICE_ACCOUNT_JSON (raw or base64).
 */
export function vertex(): { ai: GoogleGenAI; model: string } {
  if (client) return client;
  const env = vertexEnv();
  const credentials = env.GOOGLE_SERVICE_ACCOUNT_JSON ? parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  client = {
    ai: new GoogleGenAI({
      vertexai: true,
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.GOOGLE_CLOUD_LOCATION,
      ...(credentials ? { googleAuthOptions: { credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] } } : {}),
    }),
    model: env.VERTEX_MODEL,
  };
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
  if (!text) throw new Error('Vertex AI returned an empty response.');
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
