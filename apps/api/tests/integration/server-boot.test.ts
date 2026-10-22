import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The real entry point (src/server.ts), started as its own process the way Render
 * starts it: it must come up, report healthy and ready, and stop cleanly on SIGTERM —
 * and in production it must refuse to start with an unsafe configuration.
 */

const PORT = 40_000 + Math.floor(Math.random() * 10_000);

function start(env: Record<string, string>): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  let out = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, output: () => out, exited };
}

async function waitFor(url: string, ms = 30_000): Promise<Response> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await fetch(url);
    } catch {
      if (Date.now() > until) throw new Error(`${url} never answered`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describe.runIf(process.env.TEST_DATABASE_URL)('the server process', () => {
  it('boots, reports healthy and ready, and shuts down cleanly on SIGTERM', async () => {
    const s = start({ NODE_ENV: 'development', PORT: String(PORT), DATABASE_URL: process.env.TEST_DATABASE_URL!, DEMO_MODE: 'false' });
    try {
      const health = await waitFor(`http://127.0.0.1:${PORT}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, service: 'tracepay-api' });
      const ready = await fetch(`http://127.0.0.1:${PORT}/api/ready`);
      expect(await ready.json()).toMatchObject({ ok: true });
      s.child.kill('SIGTERM');
      expect(await s.exited).toBe(0);
    } finally {
      s.child.kill('SIGKILL');
    }
  }, 60_000);

  it('refuses to start in production with an incomplete configuration, and says why', async () => {
    const s = start({ NODE_ENV: 'production', PORT: String(PORT + 1), DATABASE_URL: process.env.TEST_DATABASE_URL!, AUDIT_SIGNING_PRIVATE_KEY: 'x' });
    const code = await Promise.race([s.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
    s.child.kill('SIGKILL');
    expect(code).not.toBe('timeout');
    expect(code).not.toBe(0);
    expect(s.output()).toMatch(/APP_BASE_URL must be the public web address/);
    expect(s.output()).toMatch(/PAYPAL_WEBHOOK_ID is required/);
  }, 60_000);
});
