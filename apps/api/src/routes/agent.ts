import { Router, type Request } from 'express';
import { z } from 'zod';
import { BuildIntentSchema, type PreflightReport } from '@tracepay/shared';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { ownedBuild, publisherScope } from '../http/access';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';

const MAX_ACTIVE_RUNS = 2;
import { AgentStateError, cancelRun, createRunWithinCap, decideReplacement, runAgent, TooManyRunsError } from '../modules/agent/agent.service';
import { explainPreflight } from '../modules/builds/explain';

const StartBody = z.object({
  goal: z.string().min(10).max(2000),
  intent: BuildIntentSchema,
  assetVersionIds: z.array(z.string().min(1)).min(1).max(20),
  autoReplace: z.boolean().default(false),
});

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);

export function agentRoutes({ db, planner, writer, config }: AppDeps) {
  const r = Router();

  /** Runs in the background; the UI polls the run for its live trace. */
  const runInBackground = (runId: string) => {
    void runAgent(db, planner(), writer(), runId).catch((err) => console.error(`agent run ${runId} crashed`, err));
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
    const runs = await db.agentRun.findMany({ where: publisherScope(currentUser(req)), orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, goal: true, status: true, model: true, createdAt: true, summary: true } });
    res.json({ runs });
  });

  r.get('/agent/runs/:id', requireRole('publisher', 'admin'), async (req, res) => {
    const run = await db.agentRun.findFirst({
      where: { id: param(req, 'id'), ...publisherScope(currentUser(req)) },
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

  r.post('/agent/runs/:id/cancel', requireRole('publisher'), async (req, res) => {
    const runId = param(req, 'id');
    try {
      await cancelRun(db, runId, currentUser(req).id);
    } catch (err) {
      if (err instanceof AgentStateError) throw new HttpError(err.message === 'Run not found.' ? 404 : 409, err.message);
      throw err;
    }
    res.json({ runId, status: 'failed' });
  });

  r.get('/builds/:id/explain', requireRole('publisher', 'admin'), async (req, res) => {
    const { id } = await ownedBuild(db, currentUser(req), param(req, 'id'));
    const build = await db.buildJob.findUniqueOrThrow({ where: { id }, select: { preflight: true } });
    res.json(await explainPreflight(build.preflight as unknown as PreflightReport, config.vertexReady));
  });

  return r;
}
