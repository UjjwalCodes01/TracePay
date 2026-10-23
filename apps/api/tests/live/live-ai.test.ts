import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildIntent, PreflightReport } from '@tracepay/shared';
import { db } from '../../src/db';
import { createApp } from '../../src/app';
import { createRun, decideReplacement, runAgent } from '../../src/modules/agent/agent.service';
import { GeminiPlanner } from '../../src/modules/agent/planners';
import { explainPreflight } from '../../src/modules/builds/explain';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { DEMO_ASSETS, DEMO_IDS } from '../../src/modules/demo/world';
import { VertexAnswerWriter, VertexReportWriter } from '../../src/modules/generation/writers';
import { extractTerms } from '../../src/modules/licenses/extract';
import { FakePayPal } from '../fake-paypal';
import { testDeps } from '../test-app';

/**
 * Every AI flow against the real model (Gemini through Vertex AI or the Gemini API), with PayPal
 * faked and a local database. Costs a few cents, so it never runs in CI:
 *
 *   GOOGLE_CLOUD_PROJECT=… GOOGLE_CLOUD_LOCATION=global VERTEX_MODEL=… npm run test:live-ai -w @tracepay/api
 *   (or GEMINI_API_KEY=…)
 */

const A = 'asset_northwind_index_v1';
const B = 'asset_okafor_notes_v1';
const C = 'asset_kestrel_panel_v1';
const intent: BuildIntent = {
  title: 'Developer Tools Market Brief, Q4 2026',
  brief: 'Developer-tools spend, AI coding assistant adoption, developer trust and pricing, with five findings and an outlook.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includesRawData: false,
  territory: 'US',
  priceCents: 2000,
  currency: 'USD',
};
const QUESTION = 'How fast is spending on AI coding assistants growing, and how many developers use an assistant weekly?';

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 240_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.runIf(process.env.LIVE_AI === '1' && process.env.TEST_DATABASE_URL)('every AI flow, against the real model', () => {
  beforeEach(async () => {
    await resetAndSeed(db());
  });

  it('the research assistant recovers from a blocked source with the publisher’s approval, and the report it writes cites real passages', async () => {
    const planner = new GeminiPlanner();
    const run = await createRun(db(), planner, { publisherId: DEMO_IDS.publisher, goal: 'Create a commercial developer-tools market report from my chosen sources. If a source fails the license check, find a compatible replacement.', intent, selection: [A, B, C], policy: { autoReplace: false } });
    await runAgent(db(), planner, new VertexReportWriter(), run.id);
    const paused = await db().agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(paused.status, paused.summary ?? '').toBe('awaiting_approval');

    await decideReplacement(db(), run.id, DEMO_IDS.publisher, true);
    await runAgent(db(), planner, new VertexReportWriter(), run.id);
    const done = await db().agentRun.findUniqueOrThrow({ where: { id: run.id }, include: { builds: { include: { artifact: true } } } });
    expect(done.status, done.summary ?? '').toBe('completed');
    const artifact = done.builds.find((b) => b.artifact)?.artifact;
    expect(artifact?.fromFixture).toBe(false);
    expect((artifact?.citationReport as { ok?: boolean } | null)?.ok).toBe(true);
    process.stderr.write(`report by ${artifact?.model}; summary: ${done.summary}` + '\n');
  }, 600_000);

  it('answers a question from licensed sources and pays the contributors it really relied on', async () => {
    const paypal = new FakePayPal();
    const deps = testDeps(paypal);
    const app = createApp({ ...deps, answerWriter: () => new VertexAnswerWriter() });
    const buyer = { 'X-Demo-User': 'user_buyer' };
    const started = await request(app).post('/api/credits/top-ups').set(buyer).send({ amountCents: 500 }).expect(201);
    paypal.approve(started.body.orderId);
    await request(app).post(`/api/credits/top-ups/${started.body.topUpId}/capture`).set(buyer).expect(200);

    const { answer } = (await request(app).post('/api/answers').set(buyer).send({ libraryId: DEMO_IDS.publisher, question: QUESTION, maxPriceCents: 50 }).expect(201)).body;
    expect(answer.status, JSON.stringify(answer)).toBe('answered');
    expect(answer.fromFixture).toBe(false);
    expect(answer.chargedCents).toBeGreaterThan(0);
    expect(answer.chargedCents).toBeLessThanOrEqual(50);
    process.stderr.write(`answer (${answer.chargedCents}¢): ${answer.text}` + '\n');
  }, 300_000);

  it('the shopping assistant finds the report, checks it and proposes buying it within budget', async () => {
    const paypal = new FakePayPal();
    const app = createApp({ ...testDeps(paypal), planner: () => new GeminiPlanner(), writer: () => new VertexReportWriter() });
    const publisher = { 'X-Demo-User': 'user_atlas' };
    const buyer = { 'X-Demo-User': 'user_buyer' };
    const passed = await request(app).post('/api/builds/preflight').set(publisher).send({ intent, assetVersionIds: [A, B, 'asset_lumen_digest_v1'] }).expect(201);
    await request(app).post(`/api/builds/${passed.body.buildId}/generate`).set(publisher).expect(201);

    const start = await request(app).post('/api/shopper/runs').set(buyer).send({ goal: 'I need a recent market brief on developer tools and how teams adopt AI coding assistants.', budgetCents: 2500 }).expect(202);
    const run = await until(
      async () => (await request(app).get(`/api/shopper/runs/${start.body.runId}`).set(buyer)).body.run,
      (r) => r.status !== 'running',
    );
    expect(run.status, run.summary ?? '').toBe('awaiting_approval');
    expect(run.pending.priceCents).toBe(2000);
    process.stderr.write(`shopper reason: ${run.pending.reason}` + '\n');
  }, 300_000);

  it('drafts license terms from a contract, quoting the sentence behind each term', async () => {
    const notes = DEMO_ASSETS.find((a) => a.id === 'asset_okafor_notes')!;
    const r = await extractTerms(notes.licenseText, { useModel: true, today: '2026-10-23' });
    expect(r.source).toBe('vertex');
    expect(r.terms.economics).toEqual({ kind: 'percent_of_gross', bps: 1500 });
    expect(r.terms.payableOn).toBe('cited_in_output');
    expect(r.evidence.length).toBeGreaterThan(0);
  }, 120_000);

  it('explains a blocked license check in plain words without changing the verdict', async () => {
    const report: PreflightReport = {
      policyVersion: 'tracepay-policy/1',
      verdict: 'block',
      results: [{ ruleId: 'PURPOSE_ALLOWED', outcome: 'fail', message: '"Kestrel Enterprise Engineering Panel 2026" may be used only for internal research, not reports that are sold.', assetVersionId: C }],
      obligations: [],
      economics: { priceCents: 2000, totalBps: 0, fixedFeesCents: 0, maxContributorCents: 0, minPublisherResidualCents: 2000 },
    };
    const out = await explainPreflight(report, true);
    expect(out).toMatchObject({ verdict: 'block', source: 'vertex' });
    process.stderr.write(`explainer: ${out.headline} ${out.explanation} ${out.suggestedFix}` + '\n');
  }, 120_000);
});
