import { Router, type Request } from 'express';
import { z } from 'zod';
import { BuildIntentSchema, type PreflightReport } from '@tracepay/shared';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/demo-auth';
import { HttpError } from '../http/errors';
import { AgentStateError, createRun, decideReplacement, runAgent } from '../modules/agent/agent.service';
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

  r.post('/agent/runs', requireRole('publisher'), async (req, res) => {
    const body = StartBody.parse(req.body);
    const run = await createRun(db, planner(), {
      publisherId: currentUser(req).id,
      goal: body.goal,
      intent: body.intent,
      selection: body.assetVersionIds,
      policy: { autoReplace: body.autoReplace },
    });
    runInBackground(run.id);
    res.status(202).json({ runId: run.id, planner: run.model });
  });

  r.get('/agent/runs', requireRole('publisher', 'admin'), async (_req, res) => {
    const runs = await db.agentRun.findMany({ orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, goal: true, status: true, model: true, createdAt: true, summary: true } });
    res.json({ runs });
  });

  r.get('/agent/runs/:id', requireRole('publisher', 'admin'), async (req, res) => {
    const run = await db.agentRun.findUnique({
      where: { id: param(req, 'id') },
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

  r.get('/builds/:id/explain', requireRole('publisher', 'admin'), async (req, res) => {
    const build = await db.buildJob.findUnique({ where: { id: param(req, 'id') }, select: { preflight: true } });
    if (!build) throw new HttpError(404, 'Build not found.');
    res.json(await explainPreflight(build.preflight as unknown as PreflightReport, config.vertexReady));
  });

  return r;
}
