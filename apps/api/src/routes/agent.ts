import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { BuildIntentSchema, type PreflightReport } from '@tracepay/shared';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { ownedBuild, publisherScope } from '../http/access';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';

import { AgentStateError, cancelRun, createRunWithinCap, createShopperRunWithinCap, decidePurchase, decideReplacement, proposalPayment, resumePaidPurchase, runAgent, TooManyRunsError } from '../modules/agent/agent.service';
import { isDemoBuyer } from '../modules/answers/credits.service';
import { explainPreflight } from '../modules/builds/explain';
import { activateMandate, currentMandate, MANDATE_MAX_DAYS, MANDATE_MAX_TOTAL_CENTS, MandateError, revokeMandate, startMandate } from '../modules/agent/mandates.service';

const MAX_ACTIVE_RUNS = 2;

const ShopperBody = z.object({
  goal: z.string().trim().min(10).max(1000),
  /** $1 – $1,000 (sandbox). */
  budgetCents: z.number().int().min(100).max(100_000),
  maxPurchases: z.number().int().min(1).max(3).default(1),
});

const StartBody = z.object({
  goal: z.string().min(10).max(2000),
  intent: BuildIntentSchema,
  assetVersionIds: z.array(z.string().min(1)).min(1).max(20),
  autoReplace: z.boolean().default(false),
});

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);

export function agentRoutes({ db, planner, writer, config, paypal }: AppDeps) {
  const r = Router();

  /** Runs in the background; the UI polls the run for its live trace. A buyer's run may pay within their mandate. */
  const runInBackground = (runId: string, buyerId?: string) => {
    const payments = buyerId ? { paypal: paypal(), appBaseUrl: config.appBaseUrl, allowRepeat: !!config.demoSharedBuyer && isDemoBuyer(buyerId) } : undefined;
    void runAgent(db, planner(), writer(), runId, { payments }).catch((err) => console.error(`agent run ${runId} crashed`, err));
  };

  r.post('/agent/runs', requireRole('publisher'), quotas.agentRun(), async (req, res) => {
    const body = StartBody.parse(req.body);
    // Each run makes model calls in the background: cap how many one publisher has going.
    let run;
    try {
      run = await createRunWithinCap(
        db,
        planner(),
        { publisherId: currentUser(req).id, goal: body.goal, intent: body.intent, selection: body.assetVersionIds, policy: { autoReplace: body.autoReplace } },
        MAX_ACTIVE_RUNS,
      );
    } catch (err) {
      if (err instanceof TooManyRunsError) throw new HttpError(429, `${err.message.replace('agent runs', 'assistant runs').replace('Wait for one to finish.', 'Finish or stop one of them first.')}`);
      throw err;
    }
    runInBackground(run.id);
    res.status(202).json({ runId: run.id, planner: run.model });
  });

  r.get('/agent/runs', requireRole('publisher', 'admin'), async (req, res) => {
    const runs = await db.agentRun.findMany({ where: { kind: 'publisher', ...publisherScope(currentUser(req)) }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, goal: true, status: true, model: true, createdAt: true, summary: true } });
    res.json({ runs });
  });

  r.get('/agent/runs/:id', requireRole('publisher', 'admin'), async (req, res) => {
    const run = await db.agentRun.findFirst({
      where: { id: param(req, 'id'), kind: 'publisher', ...publisherScope(currentUser(req)) },
      select: {
        id: true, goal: true, status: true, model: true, policy: true, intent: true, selection: true, pending: true, summary: true, createdAt: true, finishedAt: true,
        steps: { orderBy: { ordinal: 'asc' } },
        builds: { orderBy: { createdAt: 'asc' }, select: { id: true, status: true, artifact: { select: { id: true } } } },
      },
    });
    if (!run) throw new HttpError(404, 'Run not found.');
    res.json({ run });
  });

  r.post('/agent/runs/:id/decision', requireRole('publisher'), async (req, res) => {
    const { approved } = z.object({ approved: z.boolean() }).parse(req.body);
    const runId = param(req, 'id');
    try {
      await decideReplacement(db, runId, currentUser(req).id, approved);
    } catch (err) {
      if (err instanceof AgentStateError) throw new HttpError(409, err.message);
      throw err;
    }
    runInBackground(runId);
    res.status(202).json({ runId, approved });
  });

  const cancel = async (req: Request, res: Response) => {
    const runId = param(req, 'id');
    try {
      await cancelRun(db, runId, currentUser(req).id);
    } catch (err) {
      if (err instanceof AgentStateError) throw new HttpError(err.message === 'Run not found.' ? 404 : 409, err.message);
      throw err;
    }
    res.json({ runId, status: 'failed' });
  };
  r.post('/agent/runs/:id/cancel', requireRole('publisher'), cancel);

  // ---- Shopping Assistant (agentic commerce, buyer side) ----------------------------------
  // The assistant searches, checks licenses and proposes; the buyer pays in PayPal.

  r.post('/shopper/runs', requireRole('buyer'), quotas.agentRun(), async (req, res) => {
    const body = ShopperBody.parse(req.body);
    let run;
    try {
      const buyerId = currentUser(req).id;
      const policy = { budgetCents: body.budgetCents, maxPurchases: body.maxPurchases, ...(config.demoSharedBuyer && isDemoBuyer(buyerId) ? { repeatPurchases: true } : {}) };
      run = await createShopperRunWithinCap(db, planner(), { buyerId, goal: body.goal, policy }, MAX_ACTIVE_RUNS);
    } catch (err) {
      if (err instanceof TooManyRunsError) throw new HttpError(429, 'You already have two shopping runs going. Finish or stop one of them first.');
      throw err;
    }
    runInBackground(run.id, currentUser(req).id);
    res.status(202).json({ runId: run.id, planner: run.model });
  });

  r.get('/shopper/runs', requireRole('buyer'), async (req, res) => {
    const runs = await db.agentRun.findMany({
      where: { kind: 'buyer', publisherId: currentUser(req).id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, goal: true, status: true, model: true, policy: true, createdAt: true, summary: true },
    });
    res.json({ runs });
  });

  r.get('/shopper/runs/:id', requireRole('buyer'), async (req, res) => {
    // Paid but not yet told (a lost reply, a full-page PayPal return, a capture PayPal finished later): carry on.
    if (await resumePaidPurchase(db, param(req, 'id'), currentUser(req).id)) runInBackground(param(req, 'id'), currentUser(req).id);
    const run = await db.agentRun.findFirst({
      where: { id: param(req, 'id'), kind: 'buyer', publisherId: currentUser(req).id },
      select: { id: true, goal: true, status: true, model: true, policy: true, pending: true, summary: true, createdAt: true, finishedAt: true, steps: { orderBy: { ordinal: 'asc' } } },
    });
    if (!run) throw new HttpError(404, 'Run not found.');
    // Only the proposal, never the loop's bookkeeping (call ids, partial results).
    const p = run.pending as { type?: string; artifactId?: string; title?: string; priceCents?: number; currency?: string; reason?: string } | null;
    const pending =
      p?.type === 'purchase' && p.artifactId
        ? { artifactId: p.artifactId, title: p.title, priceCents: p.priceCents, currency: p.currency, reason: p.reason, payment: await proposalPayment(db, run.id, currentUser(req).id, p.artifactId) }
        : null;
    res.json({ run: { ...run, pending } });
  });

  r.post('/shopper/runs/:id/decision', requireRole('buyer'), async (req, res) => {
    const { approved } = z.object({ approved: z.boolean() }).parse(req.body);
    const runId = param(req, 'id');
    try {
      await decidePurchase(db, runId, currentUser(req).id, approved);
    } catch (err) {
      if (err instanceof AgentStateError) throw new HttpError(err.message === 'Run not found.' ? 404 : 409, err.message);
      throw err;
    }
    runInBackground(runId, currentUser(req).id);
    res.status(202).json({ runId, approved });
  });

  // ---- spending mandate: the buyer's assistant may pay on its own, within limits -------------

  const MandateBody = z.object({
    maxPerPurchaseCents: z.number().int().min(100).max(MANDATE_MAX_TOTAL_CENTS),
    maxTotalCents: z.number().int().min(100).max(MANDATE_MAX_TOTAL_CENTS),
    days: z.number().int().min(1).max(MANDATE_MAX_DAYS),
  });
  const mandateFailure = (err: unknown): never => {
    if (err instanceof MandateError) throw new HttpError({ not_found: 404, state: 409, limit: 400, provider: 502 }[err.code], err.message, { code: err.code });
    throw err;
  };

  r.get('/shopper/mandate', requireRole('buyer'), async (req, res) => {
    res.json({ mandate: await currentMandate(db, currentUser(req).id) });
  });

  r.post('/shopper/mandate', requireRole('buyer'), quotas.checkout(), async (req, res) => {
    const body = MandateBody.parse(req.body);
    const started = await startMandate(db, paypal(), { buyerId: currentUser(req).id, ...body, appBaseUrl: config.appBaseUrl }).catch(mandateFailure);
    res.status(201).json(started);
  });

  r.post('/shopper/mandate/:id/activate', requireRole('buyer'), async (req, res) => {
    res.json({ mandate: await activateMandate(db, paypal(), param(req, 'id'), currentUser(req).id).catch(mandateFailure) });
  });

  r.delete('/shopper/mandate', requireRole('buyer'), async (req, res) => {
    await revokeMandate(db, paypal(), currentUser(req).id);
    res.json({ mandate: null });
  });

  r.post('/shopper/runs/:id/cancel', requireRole('buyer'), cancel);

  r.get('/builds/:id/explain', requireRole('publisher', 'admin'), async (req, res) => {
    const { id } = await ownedBuild(db, currentUser(req), param(req, 'id'));
    const build = await db.buildJob.findUniqueOrThrow({ where: { id }, select: { preflight: true } });
    res.json(await explainPreflight(build.preflight as unknown as PreflightReport, config.vertexReady));
  });

  return r;
}
