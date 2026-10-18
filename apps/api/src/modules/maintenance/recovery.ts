import type { Db } from '../../db';
import { appendAudit } from '../audit/audit-log';

/**
 * Agent runs and report generation execute inside the API process. If the
 * process restarts mid-way, their rows would stay "running"/"generating"
 * forever. This sweep marks work older than the threshold as interrupted so
 * the UI can show it and the publisher can retry.
 */
export const STALE_WORK_MS = 10 * 60_000;

export async function recoverStaleWork(db: Db, now = new Date()): Promise<{ agentRuns: number; builds: number }> {
  const cutoff = new Date(now.getTime() - STALE_WORK_MS);

  const runs = await db.agentRun.findMany({ where: { status: 'running', updatedAt: { lt: cutoff } }, select: { id: true } });
  for (const r of runs) {
    await db.$transaction(async (tx) => {
      const res = await tx.agentRun.updateMany({
        where: { id: r.id, status: 'running' },
        data: { status: 'failed', finishedAt: now, summary: 'Interrupted (the server restarted). Start the run again.' },
      });
      if (res.count) await appendAudit(tx, { entityType: 'agent_run', entityId: r.id, eventType: 'agent.failed', payload: { error: 'interrupted' } });
    });
  }

  const builds = await db.buildJob.updateMany({ where: { status: 'generating', updatedAt: { lt: cutoff } }, data: { status: 'generation_failed' } });
  return { agentRuns: runs.length, builds: builds.count };
}
