/**
 * Where an answer being written has got to, so the asker sees real steps instead of a spinner for
 * the 10–20 seconds it takes. The asker's page picks a random id, sends it with the question and
 * polls it; only the same asker can read it. In memory and short-lived: progress is a courtesy, and
 * if it's missing (another server instance, a restart) the page just shows the steps unticked.
 */

export const ANSWER_STAGES = ['rights', 'retrieval', 'screen', 'budget', 'writing', 'judging', 'settling'] as const;
export type AnswerStage = (typeof ANSWER_STAGES)[number];

export const PROGRESS_ID = /^[A-Za-z0-9_-]{16,64}$/;
const TTL_MS = 5 * 60_000;
const MAX_TRACKED = 5_000;

interface Tracked {
  askerId: string;
  startedAt: number;
  stages: Array<{ stage: AnswerStage; at: number }>;
}

const tracked = new Map<string, Tracked>();

function sweep(now: number) {
  for (const [id, t] of tracked) if (now - t.startedAt > TTL_MS) tracked.delete(id);
  // Still full: drop the oldest (Maps keep insertion order).
  while (tracked.size >= MAX_TRACKED) tracked.delete(tracked.keys().next().value!);
}

/** A reporter for one answer; a no-op without a valid id, or for an id another asker already holds. */
export function progressReporter(askerId: string, progressId?: string): (stage: AnswerStage) => void {
  if (!progressId || !PROGRESS_ID.test(progressId)) return () => {};
  const now = Date.now();
  const existing = tracked.get(progressId);
  if (existing && existing.askerId !== askerId) return () => {};
  sweep(now);
  const t: Tracked = { askerId, startedAt: now, stages: [] };
  tracked.set(progressId, t);
  return (stage) => {
    if (t.stages.at(-1)?.stage !== stage) t.stages.push({ stage, at: Date.now() - t.startedAt });
  };
}

/** The stages reached so far (milliseconds since the question arrived), or null. */
export function readProgress(askerId: string, progressId: string): { stages: Tracked['stages']; elapsedMs: number } | null {
  const t = tracked.get(progressId);
  if (!t || t.askerId !== askerId || Date.now() - t.startedAt > TTL_MS) return null;
  return { stages: [...t.stages], elapsedMs: Date.now() - t.startedAt };
}
