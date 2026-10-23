import { afterEach, describe, expect, it } from 'vitest';
import { aiConfig } from '../src/config/env';

const KEYS = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'VERTEX_MODEL', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'NODE_ENV'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const setEnv = (vars: Record<string, string>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
};

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('aiConfig', () => {
  it('is null when no model is configured, so the labelled fallbacks run', () => {
    setEnv({ GEMINI_API_KEY: '   ', VERTEX_MODEL: 'gemini-2.5-flash' });
    expect(aiConfig()).toBeNull();
  });

  it('uses a Gemini API key, with a default model', () => {
    setEnv({ GEMINI_API_KEY: ' key-123 ' });
    expect(aiConfig()).toEqual({ provider: 'gemini-api', apiKey: 'key-123', model: 'gemini-flash-latest' });
    setEnv({ GEMINI_API_KEY: 'key-123', GEMINI_MODEL: 'gemini-2.5-pro' });
    expect(aiConfig()).toMatchObject({ model: 'gemini-2.5-pro' });
  });

  it('prefers Vertex AI when both are configured', () => {
    setEnv({ GEMINI_API_KEY: 'key-123', GOOGLE_CLOUD_PROJECT: 'proj', VERTEX_MODEL: 'gemini-2.5-flash' });
    expect(aiConfig()).toEqual({ provider: 'vertex', project: 'proj', location: 'us-central1', model: 'gemini-2.5-flash', serviceAccountJson: undefined });
  });

  it('on a server, counts Vertex AI as configured only once its key is there', () => {
    setEnv({ NODE_ENV: 'production', GOOGLE_CLOUD_PROJECT: 'proj', GOOGLE_CLOUD_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.5-flash' });
    expect(aiConfig()).toBeNull();
    setEnv({ NODE_ENV: 'production', GOOGLE_CLOUD_PROJECT: 'proj', GOOGLE_CLOUD_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.5-flash', GOOGLE_SERVICE_ACCOUNT_JSON: 'e30=' });
    expect(aiConfig()).toMatchObject({ provider: 'vertex', location: 'global', serviceAccountJson: 'e30=' });
  });
});
