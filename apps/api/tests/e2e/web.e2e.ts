/// <reference lib="dom" />
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { softResetDemo } from '../../src/modules/demo/soft-reset';
import { FakePayPal } from '../fake-paypal';
import { testApp } from '../test-app';

/**
 * The web app in a real browser, against a real API (fake PayPal, test database):
 * every page for every role renders cleanly, phones don't scroll sideways, there are no
 * serious accessibility violations, and the pay-per-citation flow works end to end.
 *
 *   npm run test:e2e -w @tracepay/api     (builds the web app if needed)
 * Uses an installed Chrome/Chromium/Firefox (E2E_BROWSER=/path/to/browser to choose).
 */

const WEB = new URL('../../../web', import.meta.url).pathname;
const require = createRequire(import.meta.url);

function findBrowser(): { path: string; kind: 'chrome' | 'firefox' } {
  const pick = (path: string) => ({ path, kind: /firefox/i.test(path) ? ('firefox' as const) : ('chrome' as const) });
  if (process.env.E2E_BROWSER) return pick(process.env.E2E_BROWSER);
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/firefox']) if (existsSync(p)) return pick(p);
  throw new Error('No browser found: install Chrome, Chromium or Firefox, or set E2E_BROWSER.');
}

const ROLES = {
  publisher: { id: 'user_atlas', pages: ['/dashboard', '/registry', '/studio', '/reports', '/settlements', '/royalties', '/developers', '/profile'] },
  buyer: { id: 'user_buyer', pages: ['/store', '/ask', '/assistant', '/developers', '/profile'] },
  contributor: { id: 'user_okafor', pages: ['/sources', '/earnings', '/profile'] },
} as const;

/** Text that means something broke, whatever the page. */
const BROKEN = /Unexpected Application Error|Something went wrong|Internal error|undefined|NaN|\[object Object\]|AG Grid found/;

describe.runIf(process.env.TEST_DATABASE_URL)('the web app in a browser', () => {
  let api: Server;
  let preview: ChildProcess;
  let browser: Browser;
  let base: string;
  const problems: string[] = [];

  beforeAll(async () => {
    // As the hosted demo runs (DEMO_MODE): royalties are payable at once, from 1¢.
    process.env.CREDIT_CLEARING_DAYS = '0';
    process.env.ROYALTY_PAYOUT_MIN_CENTS = '1';
    await resetAndSeed(db());
    await softResetDemo(db());
    const port = 41_000 + Math.floor(Math.random() * 5_000);
    base = `http://127.0.0.1:${port}`;
    // The app is served from the preview's address: that's the origin the API must trust for writes.
    api = testApp(new FakePayPal(), { corsOrigins: [base], appBaseUrl: base }).listen(0);
    await new Promise((r) => api.once('listening', r));
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    if (!existsSync(`${WEB}/dist/index.html`) || process.env.E2E_REBUILD) execSync('npm run build', { cwd: WEB, stdio: 'ignore' });
    // Vite itself (not through npx), in its own process group, so stopping it stops everything it started.
    preview = spawn(process.execPath, [`${dirname(require.resolve('vite/package.json', { paths: [WEB] }))}/bin/vite.js`, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: WEB,
      env: { ...process.env, VITE_API_PROXY: apiUrl },
      stdio: 'ignore',
      detached: true,
    });
    for (let i = 0; i < 120; i++) {
      if (await fetch(base).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    const b = findBrowser();
    browser = await puppeteer.launch({ browser: b.kind, executablePath: b.path, headless: true, args: b.kind === 'chrome' ? ['--no-sandbox'] : [] });
  }, 180_000);

  // Each test reports only its own problems.
  beforeEach(() => {
    problems.length = 0;
  });

  afterAll(async () => {
    await browser?.close();
    if (preview?.pid) {
      try {
        process.kill(-preview.pid, 'SIGTERM'); // the whole group
      } catch {
        preview.kill('SIGTERM');
      }
    }
    await new Promise((r) => api?.close(r));
  });

  async function open(role: keyof typeof ROLES, path: string, width = 1280): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    page.on('pageerror', (e) => problems.push(`${role} ${path}: page error: ${(e as Error).message}`));
    page.on('console', (m) => {
      // The PayPal SDK can't load with the tests' placeholder client id; that's expected.
      if (m.type() === 'error' && !/paypal/i.test(m.text() + (m.location()?.url ?? ''))) problems.push(`${role} ${path}: console: ${m.text()}`);
    });
    await page.goto(`${base}/login`);
    await page.evaluate((id) => localStorage.setItem('tracepay.demoUser', id), ROLES[role].id);
    await page.goto(`${base}${path}`);
    await settle(page);
    return page;
  }

  /** Until loading indicators are gone (or 8 s). */
  async function settle(page: Page) {
    for (let i = 0; i < 40; i++) {
      const loading = await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some((e) => /Loading/i.test(e.textContent ?? '')));
      if (!loading) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  it('renders every page for every role without errors, with a proper title', async () => {
    for (const role of Object.keys(ROLES) as Array<keyof typeof ROLES>) {
      for (const path of ROLES[role].pages) {
        const page = await open(role, path);
        const text = await page.evaluate(() => document.body.innerText);
        if (BROKEN.test(text)) problems.push(`${role} ${path}: shows "${text.match(BROKEN)![0]}"`);
        // Lazily loaded pages set their title a moment after the first paint.
        const titled = await page.waitForFunction(() => / · TracePay$/.test(document.title), { timeout: 10_000 }).then(() => true, () => false);
        if (!titled) problems.push(`${role} ${path}: title "${await page.title()}"`);
        if (new URL(page.url()).pathname !== path) problems.push(`${role} ${path}: redirected to ${new URL(page.url()).pathname}`);
        await page.close();
      }
    }
    expect(problems).toEqual([]);
  }, 240_000);

  it('never scrolls sideways on a phone, on any page', async () => {
    const overflow: string[] = [];
    for (const role of Object.keys(ROLES) as Array<keyof typeof ROLES>) {
      for (const path of ROLES[role].pages) {
        const page = await open(role, path, 375);
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        if (width > 375) overflow.push(`${role} ${path}: ${width}px wide`);
        await page.close();
      }
    }
    expect(overflow).toEqual([]);
  }, 300_000);

  it('has no serious accessibility problems (axe, WCAG 2 A/AA)', async () => {
    const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    const found: string[] = [];
    for (const [role, path] of [['buyer', '/ask'], ['buyer', '/store'], ['publisher', '/dashboard'], ['publisher', '/royalties'], ['contributor', '/earnings'], ['publisher', '/profile']] as const) {
      const page = await open(role, path);
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => {
        // @ts-expect-error injected
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return r.violations
          .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
          .map((v: { id: string; help: string; nodes: Array<{ target: string[] }> }) => `${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')})`);
      });
      found.push(...violations.map((v: string) => `${role} ${path}: ${v}`));
      await page.close();
    }
    expect(found).toEqual([]);
  }, 180_000);

  it('gives a first-time visitor a private demo world of their own', async () => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`first visit: page error: ${(e as Error).message}`));
    await page.goto(`${base}/`);
    await page.waitForFunction(() => /Guided demo/.test(document.body.innerText), { timeout: 30_000 });
    const stored = await page.evaluate(() => ({ user: localStorage.getItem('tracepay.demoUser'), world: localStorage.getItem('tracepay.demoWorld') }));
    expect(stored.user).toMatch(/^dw_[a-z0-9]{12}_user_atlas$/);
    expect(stored.world).toMatch(/^[a-z0-9]{12}\./);
    // Create a report starts with the demo's three sources ticked — in this private world too.
    await page.goto(`${base}/studio`);
    await page.waitForFunction(() => /3 chosen/.test(document.body.innerText), { timeout: 20_000 });
    await context.close();
    expect(problems).toEqual([]);
  }, 60_000);

  it('lets a buyer ask and pay authors, and the publisher pay them out with PayPal', async () => {
    const ask = await open('buyer', '/ask');
    // The Ask button enables once the library list has loaded.
    await ask.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Ask' && !(b as HTMLButtonElement).disabled), { timeout: 20_000 });
    await ask.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Ask')?.click());
    await ask.waitForFunction(() => /Where your \$0\.\d\d went/.test(document.body.innerText), { timeout: 20_000 }).catch(async (e) => {
      throw new Error(`${(e as Error).message}\nPage shows:\n${(await ask.evaluate(() => document.body.innerText)).slice(0, 1500)}`);
    });
    expect(await ask.$$('button[aria-label^="Citation C"]')).not.toHaveLength(0);
    await ask.close();

    const royalties = await open('publisher', '/royalties');
    await royalties.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /with PayPal/.test(b.textContent ?? '') && !(b as HTMLButtonElement).disabled), { timeout: 20_000 });
    await royalties.evaluate(() => [...document.querySelectorAll('button')].find((b) => /with PayPal/.test(b.textContent ?? ''))?.click());
    await royalties.waitForFunction(() => /On its way/.test(document.body.innerText), { timeout: 20_000 });
    await royalties.close();
    expect(problems).toEqual([]);
  }, 120_000);
});
