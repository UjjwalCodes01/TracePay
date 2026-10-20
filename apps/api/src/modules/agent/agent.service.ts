import type { BuildIntent } from '@tracepay/shared';
import { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../db';
import { appendAudit } from '../audit/audit-log';
import type { ReportWriter } from '../generation/writers';
import type { AgentMessage, AgentPlanner } from './planners';
import { executeTool, type AgentPolicy, type PendingApproval, type ToolContext } from './tools';

export const MAX_AGENT_TURNS = 14;

const json = (v: unknown) => v as Prisma.InputJsonValue;

interface Pending extends PendingApproval {
  callId: string;
  /** Results of other calls in the same model turn, completed before the pause. */
  partialResults: Array<{ id: string; name: string; response: Record<string, unknown> }>;
  remainingCallIds: string[];
}

export class AgentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentStateError';
  }
}

export interface StartRunInput {
  publisherId: string;
  goal: string;
  intent: BuildIntent;
  selection: string[];
  policy: AgentPolicy;
}

export class TooManyRunsError extends Error {}

/**
 * Starts a run unless the publisher already has `max` running. Race-safe without
 * locks: after creating the run, only runs created BEFORE it count, so of several
 * simultaneous starts exactly the ones within the cap survive; the rest are
 * recorded as not started.
 */
export async function createRunWithinCap(db: Db, planner: AgentPlanner, input: StartRunInput, max: number) {
  const active = await db.agentRun.count({ where: { publisherId: input.publisherId, status: 'running' } });
  if (active >= max) throw new TooManyRunsError(`You already have ${active} agent runs in progress. Wait for one to finish.`);
  const run = await createRun(db, planner, input);
  const earlier = await db.agentRun.count({
    where: {
      publisherId: input.publisherId,
      status: 'running',
      id: { not: run.id },
      OR: [{ createdAt: { lt: run.createdAt } }, { createdAt: run.createdAt, id: { lt: run.id } }],
    },
  });
  if (earlier >= max) {
    await db.$transaction(async (tx) => {
      await tx.agentRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), summary: 'Not started: too many runs were already in progress.' } });
      await appendAudit(tx, { entityType: 'agent_run', entityId: run.id, eventType: 'agent.failed', payload: { error: 'too many active runs' } });
    });
    throw new TooManyRunsError(`You already have ${earlier} agent runs in progress. Wait for one to finish.`);
  }
  return run;
}

export async function createRun(db: Db, planner: AgentPlanner, input: StartRunInput) {
  const opening: AgentMessage = {
    role: 'user',
    text:
      `${input.goal}\n\nFixed intent (you cannot change it): ${JSON.stringify(input.intent)}\n` +
      `Publisher's selected source versions: SELECTION=${input.selection.join(',')}\n` +
      `Replacement policy: ${input.policy.autoReplace ? 'you may substitute compatible sources automatically' : 'every substitution needs the publisher’s approval'}.`,
  };
  return db.$transaction(async (tx) => {
    const run = await tx.agentRun.create({
      data: {
        publisherId: input.publisherId,
        goal: input.goal,
        policy: json(input.policy),
        intent: json(input.intent),
        selection: json(input.selection),
        transcript: json([opening]),
        model: `${planner.name}:${planner.model}`,
      },
    });
    await tx.agentStep.create({ data: { runId: run.id, ordinal: 0, kind: 'plan', output: json({ text: input.goal, policy: input.policy }) } });
    await appendAudit(tx, { entityType: 'agent_run', entityId: run.id, eventType: 'agent.started', payload: { goal: input.goal, selection: input.selection, policy: input.policy, planner: run.model } });
    return run;
  });
}

/**
 * The bounded agent loop: ask the planner for the next step, execute its tool
 * calls through guarded executors, record every step, and stop on a final
 * answer, a pause for publisher approval, an error or the turn limit.
 */
export async function runAgent(db: Db, planner: AgentPlanner, writer: ReportWriter, runId: string, opts: { asOf?: string } = {}) {
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.status !== 'running') throw new AgentStateError(`Run is ${run.status}.`);

  const history = run.transcript as unknown as AgentMessage[];
  const ctx: ToolContext = {
    db,
    runId,
    publisherId: run.publisherId,
    intent: run.intent as unknown as BuildIntent,
    policy: run.policy as unknown as AgentPolicy,
    selection: run.selection as unknown as string[],
    approvedReplacements: approvedReplacementsFrom(history),
    writer,
    asOf: opts.asOf,
  };
  let ordinal = await db.agentStep.count({ where: { runId } });
  const step = (kind: 'plan' | 'tool_call' | 'tool_result' | 'approval_request' | 'message' | 'error', data: { tool?: string; input?: unknown; output?: unknown }) =>
    db.agentStep.create({
      data: { runId, ordinal: ordinal++, kind, tool: data.tool ?? null, input: data.input === undefined ? undefined : json(data.input), output: data.output === undefined ? undefined : json(data.output) },
    });
  // Every write is conditional on the run still being ours to drive: if the recovery
  // sweep marked it interrupted, a late-finishing loop must not overwrite that.
  const save = async (data: Prisma.AgentRunUpdateManyMutationInput) => {
    const res = await db.agentRun.updateMany({ where: { id: runId, status: 'running' }, data: { transcript: json(history), ...data } });
    return res.count > 0;
  };

  try {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const next = await planner.next(history);
      history.push({ role: 'model', text: next.text, calls: next.calls, raw: next.raw });
      if (next.text) await step(next.calls.length ? 'plan' : 'message', { output: { text: next.text } });

      if (next.calls.length === 0) {
        await save({ status: 'completed', finishedAt: new Date(), summary: next.text });
        await audit(db, runId, 'agent.completed', { summary: next.text });
        return;
      }

      const results: Array<{ id: string; name: string; response: Record<string, unknown> }> = [];
      for (const [i, call] of next.calls.entries()) {
        await step('tool_call', { tool: call.name, input: call.args });
        const result = await executeTool(ctx, call.name, call.args);
        if (result.kind === 'pause') {
          const pending: Pending = {
            ...result.approval,
            callId: call.id,
            partialResults: results,
            remainingCallIds: next.calls.slice(i + 1).map((c) => c.id),
          };
          await step('approval_request', { tool: call.name, input: call.args, output: result.approval });
          await save({ status: 'awaiting_approval', pending: json(pending) });
          await audit(db, runId, 'agent.awaiting_approval', { ...result.approval });
          return;
        }
        await step('tool_result', { tool: call.name, output: result.response });
        results.push({ id: call.id, name: call.name, response: result.response });
      }
      history.push({ role: 'tool', results });
      if (!(await save({}))) return; // taken over (e.g. marked interrupted): stop quietly
    }
    await step('error', { output: { message: `Stopped after ${MAX_AGENT_TURNS} turns.` } });
    await save({ status: 'failed', finishedAt: new Date(), summary: 'Turn limit reached.' });
  } catch (err) {
    await step('error', { output: { message: (err as Error).message } });
    await save({ status: 'failed', finishedAt: new Date(), summary: (err as Error).message });
    await audit(db, runId, 'agent.failed', { error: (err as Error).message });
  }
}

/** The publisher decides on a proposed replacement; the run then continues. */
export async function decideReplacement(db: Db, runId: string, publisherId: string, approved: boolean) {
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.publisherId !== publisherId) throw new AgentStateError('Run not found.');
  if (run.status !== 'awaiting_approval' || !run.pending) throw new AgentStateError('This run is not waiting for a decision.');

  const pending = run.pending as unknown as Pending;
  const history = run.transcript as unknown as AgentMessage[];
  const lastModel = [...history].reverse().find((m) => m.role === 'model') as Extract<AgentMessage, { role: 'model' }>;
  const decision = approved
    ? { approved: true, by: 'publisher', replacement: pending.replacementAssetVersionId }
    : { approved: false, by: 'publisher', message: 'The publisher declined this replacement.' };

  const results = [
    ...pending.partialResults,
    { id: pending.callId, name: 'propose_replacement', response: decision },
    ...pending.remainingCallIds.map((id) => ({
      id,
      name: lastModel.calls.find((c) => c.id === id)?.name ?? 'unknown',
      response: { skipped: true, message: 'Not executed: the run paused for publisher approval. Call it again if still needed.' },
    })),
  ];
  history.push({ role: 'tool', results });

  await db.$transaction(async (tx) => {
    // Claim the decision atomically: a double click (or two tabs) can only apply it once.
    const claimed = await tx.agentRun.updateMany({
      where: { id: runId, status: 'awaiting_approval' },
      data: { status: 'running', pending: Prisma.DbNull, transcript: json(history) },
    });
    if (claimed.count === 0) throw new AgentStateError('This decision was already made.');
    const ordinal = await tx.agentStep.count({ where: { runId } });
    await tx.agentStep.create({ data: { runId, ordinal, kind: 'tool_result', tool: 'propose_replacement', output: json(decision) } });
    await appendAudit(tx, {
      entityType: 'agent_run',
      entityId: runId,
      eventType: approved ? 'agent.replacement_approved' : 'agent.replacement_declined',
      payload: { blocked: pending.blockedAssetVersionId, replacement: pending.replacementAssetVersionId, publisherId },
    });
  });
}

function approvedReplacementsFrom(history: AgentMessage[]): Record<string, string> {
  const approved: Record<string, string> = {};
  const calls = new Map<string, Record<string, unknown>>();
  for (const m of history) {
    if (m.role === 'model') for (const c of m.calls) calls.set(c.id, c.args);
    if (m.role === 'tool') {
      for (const r of m.results) {
        if (r.name === 'propose_replacement' && r.response.approved === true) {
          const args = calls.get(r.id);
          if (args) approved[args.blockedAssetVersionId as string] = args.replacementAssetVersionId as string;
        }
      }
    }
  }
  return approved;
}

async function audit(db: Db, runId: string, eventType: string, payload: Record<string, unknown>) {
  await db.$transaction((tx) => appendAudit(tx, { entityType: 'agent_run', entityId: runId, eventType, payload }));
}
