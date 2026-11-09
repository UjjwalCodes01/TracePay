import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { aiConfig } from '../src/config/env';
import { FakePayPal } from './fake-paypal';
import { testApp } from './test-app';

describe('one service: the web app served from the API’s origin', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'tracepay-web-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>TracePay</title></head><body><div id="root"></div></body></html>');
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  const app = testApp(new FakePayPal(), { webDistDir: dist });

  it('serves the app for every page, with a CSP that allows only itself and PayPal', async () => {
    for (const page of ['/', '/welcome', '/reports/abc/receipt']) {
      const res = await request(app).get(page).expect(200);
      expect(res.text).toContain('<div id="root">');
      expect(res.headers['cache-control']).toBe('no-cache');
      const csp = res.headers['content-security-policy'];
      expect(csp).toContain("script-src 'self' https://*.paypal.com https://*.paypalobjects.com");
      expect(csp).toContain('frame-src https://*.paypal.com https://*.paypalobjects.com https://*.venmo.com');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    }
  });

  it('gives every page a fresh nonce, in the CSP and in the page, for PayPal’s SDK and nothing else', async () => {
    const nonces: string[] = [];
    for (const page of ['/', '/store/abc', '/index.html']) {
      const res = await request(app).get(page).expect(200);
      const header = /'nonce-([^']+)'/.exec(String(res.headers['content-security-policy']))![1]!;
      expect(res.text).toContain(`<meta name="csp-nonce" content="${header}">`);
      nonces.push(header);
    }
    expect(new Set(nonces).size).toBe(3);
  });

  it('caches hashed bundles for a year, and 404s a missing one instead of returning the page', async () => {
    expect((await request(app).get('/assets/app-abc123.js').expect(200)).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(app).get('/assets/missing.js').expect(404)).text).toBe('Not found.');
  });

  it('leaves the API exactly as it was: JSON, locked-down CSP, unknown routes 404', async () => {
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.ok).toBe(true);
    expect(health.headers['content-security-policy']).toContain("default-src 'none'");
    await request(app).get('/api/no-such-route').expect(404);
  });
});

describe('Vertex AI on Cloud Run', () => {
  const base = { NODE_ENV: 'production', GOOGLE_CLOUD_PROJECT: 'p', VERTEX_MODEL: 'gemini-3.5-flash' } as NodeJS.ProcessEnv;
  it('counts as configured on Cloud Run (its service account vouches), not on a bare production server', () => {
    expect(aiConfig(base)).toBeNull();
    expect(aiConfig({ ...base, K_SERVICE: 'tracepay' })).toMatchObject({ provider: 'vertex', project: 'p' });
  });
});
