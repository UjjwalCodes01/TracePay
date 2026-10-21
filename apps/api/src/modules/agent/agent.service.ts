import { formatMoney, type BuildIntent } from '@tracepay/shared';
import { Prisma } from '../../generated/prisma/client';
import type { Db, Tx } from '../../db';
import { appendAudit } from '../audit/audit-log';
import type { ReportWriter } from '../generation/writers';
import type { AgentMessage, AgentPlanner } from './planners';
import { executeShopperTool, purchasesFrom, type PurchaseApproval, type ShopperContext, type ShopperPolicy } from './buyer-tools';
import { executeTool, type AgentPolicy, type PendingApproval, type ToolContext } from './tools';

export const MAX_AGENT_TURNS = 14;

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** What a paused run waits on: a source replacement (publisher) or a purchase (buyer). */
type Pending = (PendingApproval | PurchaseApproval) & {
  callId: string;
  /** Results of other calls in the same model turn, completed before the pause. */
  partialResults: Array<{ id: string; name: string; response: Record<string, unknown> }>;
  remainingCallIds: string[];
};

type ToolResults = Array<{ id: string; name: string; response: Record<string, unknown> }>;

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

export interface StartShopperInput {
  buyerId: string;
  goal: string;
  policy: ShopperPolicy;
}

/**
 * How long a run waits for a decision before it lapses. Short in demo mode, where
 * every visitor shares one publisher: abandoned runs must not lock others out.
 */
export const approvalTtlMs = () => (process.env.DEMO_MODE === 'true' ? 30 * 60_000 : 24 * 60 * 60_000);

/**
 * Starts a run unless the publisher already has `max` running. Counting and
 * inserting happen in ONE transaction under a per-publisher advisory lock, so
 * simultaneous starts are serialised: each sees the runs committed before it.
 * (Counting "runs created earlier" after the fact is not enough — a run with an
 * earlier timestamp may not be committed yet.)
 */
export async function createRunWithinCap(db: Db, planner: AgentPlanner, input: StartRunInput, max: number) {
  return withinCap(db, input.publisherId, max, (tx) => insertRun(tx, planner, input));
}

/** Starts a Shopping Assistant run for a buyer, under the same cap. */
export async function createShopperRunWithinCap(db: Db, planner: AgentPlanner, input: StartShopperInput, max: number) {
  return withinCap(db, input.buyerId, max, (tx) => insertShopperRun(tx, planner, input));
}

async function withinCap<T>(db: Db, ownerId: string, max: number, insert: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-runs:${ownerId}`}))`;
    // A run paused for approval resumes (and calls the model again) without a new start: it counts.
    const active = await tx.agentRun.count({
      where: {
        publisherId: ownerId,
        OR: [{ status: 'running' }, { status: 'awaiting_approval', updatedAt: { gt: new Date(Date.now() - approvalTtlMs()) } }],
      },
    });
    if (active >= max) throw new TooManyRunsError(`You already have ${active} agent runs in progress. Wait for one to finish.`);
    return insert(tx);
  });
}

async function insertShopperRun(tx: Tx, planner: AgentPlanner, input: StartShopperInput) {
  const opening: AgentMessage = {
    role: 'user',
    text:
      `${input.goal}\n\nBudget for this run (you cannot exceed it): ${formatMoney(input.policy.budgetCents)}.\n` +
      `You may propose up to ${input.policy.maxPurchases} purchase(s). The buyer approves each payment in PayPal.`,
  };
  const run = await tx.agentRun.create({
    data: {
      kind: 'buyer',
      publisherId: input.buyerId,
      goal: input.goal,
      policy: json(input.policy),
      intent: json({}),
      selection: json([]),
      transcript: json([opening]),
      model: `${planner.name}:${planner.model}`,
    },
  });
  await tx.agentStep.create({ data: { runId: run.id, ordinal: 0, kind: 'plan', output: json({ text: input.goal, policy: input.policy }) } });
  await appendAudit(tx, { entityType: 'agent_run', entityId: run.id, eventType: 'agent.started', payload: { kind: 'buyer', goal: input.goal, policy: input.policy, planner: run.model } });
  return run;
}

export async function createRun(db: Db, planner: AgentPlanner, input: StartRunInput) {
  return db.$transaction((tx) => insertRun(tx, planner, input));
}

async function insertRun(tx: Tx, planner: AgentPlanner, input: StartRunInput) {
  const opening: AgentMessage = {
    role: 'user',
    text:
      `${input.goal}\n\nFixed intent (you cannot change it): ${JSON.stringify(input.intent)}\n` +
      `Publisher's selected source versions: SELECTION=${input.selection.join(',')}\n` +
      `Replacement policy: ${input.policy.autoReplace ? 'you may substitute compatible sources automatically' : 'every substitution needs the publisher’s approval'}.`,
  };
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
  let execute: (name: string, args: Record<string, unknown>) => Promise<{ kind: 'result' | 'pause'; response: Record<string, unknown>; approval?: PendingApproval | PurchaseApproval }>;
  if (run.kind === 'buyer') {
    const ctx: ShopperContext = { db, runId, buyerId: run.publisherId, policy: run.policy as unknown as ShopperPolicy, purchases: purchasesFrom(history) };
    execute = (name, args) => executeShopperTool(ctx, name, args);
  } else {
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
    execute = (name, args) => executeTool(ctx, name, args);
  }
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
      const next = await planner.next(history, run.kind);
      history.push({ role: 'model', text: next.text, calls: next.calls, raw: next.raw });
      if (next.text) await step(next.calls.length ? 'plan' : 'message', { output: { text: next.text } });

      if (next.calls.length === 0) {
        await save({ status: 'completed', finishedAt: new Date(), summary: next.text });
        await audit(db, runId, 'agent.completed', { summary: next.text });
        return;
      }

      const results: ToolResults = [];
      for (const [i, call] of next.calls.entries()) {
        await step('tool_call', { tool: call.name, input: call.args });
        const result = await execute(call.name, call.args);
        if (result.kind === 'pause' && result.approval) {
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

/** Stops a run that is working or waiting for a decision. A loop still running notices and stops. */
export async function cancelRun(db: Db, runId: string, publisherId: string) {
  await db.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId }, select: { publisherId: true } });
    if (!run || run.publisherId !== publisherId) throw new AgentStateError('Run not found.');
    const res = await tx.agentRun.updateMany({
      where: { id: runId, status: { in: ['running', 'awaiting_approval'] } },
      data: { status: 'failed', pending: Prisma.DbNull, finishedAt: new Date(), summary: 'Stopped by you.' },
    });
    if (!res.count) throw new AgentStateError('This run has already finished.');
    await appendAudit(tx, { entityType: 'agent_run', entityId: runId, eventType: 'agent.cancelled', payload: { publisherId } });
  });
}

/** The publisher decides on a proposed replacement; the run then continues. */
export async function decideReplacement(db: Db, runId: string, publisherId: string, approved: boolean) {
  const { pending } = await pausedRun(db, runId, publisherId, 'publisher');
  if ('type' in pending) throw new AgentStateError('This run is not waiting for a decision.');
  const decision = approved
    ? { approved: true, by: 'publisher', replacement: pending.replacementAssetVersionId }
    : { approved: false, by: 'publisher', message: 'The publisher declined this replacement.' };
  await resume(db, runId, pending, 'propose_replacement', decision, {
    eventType: approved ? 'agent.replacement_approved' : 'agent.replacement_declined',
    payload: { blocked: pending.blockedAssetVersionId, replacement: pending.replacementAssetVersionId, publisherId },
  });
}

/**
 * The buyer's answer to a proposed purchase. "Yes" counts only once PayPal has
 * actually taken the payment (the buyer pays through the normal checkout, which
 * the server captures and verifies); the run then continues with the result.
 */
export async function decidePurchase(db: Db, runId: string, buyerId: string, approved: boolean) {
  const { pending, run } = await pausedRun(db, runId, buyerId, 'buyer');
  if (!('type' in pending) || pending.type !== 'purchase') throw new AgentStateError('This run is not waiting for a decision.');
  let decision: Record<string, unknown>;
  if (approved) {
    const sale = await db.sale.findFirst({
      where: { artifactId: pending.artifactId, buyerId, status: 'captured' },
      orderBy: { createdAt: 'desc' },
      include: { payment: { select: { captureId: true } } },
    });
    if (!sale) {
      const processing = await db.sale.count({ where: { artifactId: pending.artifactId, buyerId, status: 'pending_payment', payment: { captureId: { not: null } } } });
      throw new AgentStateError(
        processing ? 'PayPal is still processing this payment. The assistant continues once PayPal confirms it.' : 'The payment hasn’t been completed in PayPal yet.',
      );
    }
    const policy = run.policy as unknown as ShopperPolicy;
    const spentBefore = purchasesFrom(run.transcript as unknown as AgentMessage[]).reduce((n, p) => n + p.amountCents, 0);
    decision = {
      approved: true,
      purchased: true,
      by: 'buyer',
      reportId: pending.artifactId,
      saleId: sale.id,
      captureId: sale.payment?.captureId ?? null,
      amountCents: sale.amountCents,
      amount: formatMoney(sale.amountCents),
      remainingBudget: formatMoney(Math.max(0, policy.budgetCents - spentBefore - sale.amountCents)),
    };
  } else {
    decision = { approved: false, purchased: false, by: 'buyer', message: 'The buyer decided not to buy this report.' };
  }
  await resume(db, runId, pending, 'propose_purchase', decision, {
    eventType: approved ? 'agent.purchase_approved' : 'agent.purchase_declined',
    payload: { artifactId: pending.artifactId, priceCents: pending.priceCents, saleId: decision.saleId ?? null, buyerId },
  });
}

async function pausedRun(db: Db, runId: string, ownerId: string, kind: 'publisher' | 'buyer') {
  const run = await db.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.publisherId !== ownerId || run.kind !== kind) throw new AgentStateError('Run not found.');
  if (run.status !== 'awaiting_approval' || !run.pending) throw new AgentStateError('This run is not waiting for a decision.');
  return { run, pending: run.pending as unknown as Pending };
}

/** Answers the paused tool call with the decision and hands the run back to the loop. */
async function resume(db: Db, runId: string, pending: Pending, tool: string, decision: Record<string, unknown>, auditEvent: { eventType: string; payload: Record<string, unknown> }) {
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { transcript: true } });
  const history = run.transcript as unknown as AgentMessage[];
  const lastModel = [...history].reverse().find((m) => m.role === 'model') as Extract<AgentMessage, { role: 'model' }>;
  const results: ToolResults = [
    ...pending.partialResults,
    { id: pending.callId, name: tool, response: decision },
    ...pending.remainingCallIds.map((id) => ({
      id,
      name: lastModel.calls.find((c) => c.id === id)?.name ?? 'unknown',
      response: { skipped: true, message: 'Not executed: the run paused for approval. Call it again if still needed.' },
    })),
  ];
  history.push({ role: 'tool', results });

  await db.$transaction(async (tx) => {
    // Claim the decision atomically: a double click (or two tabs) can only apply it once.
    const claimed = await tx.agentRun.updateMany({
      where: { id: runId, status: 'awaiting_approval' },
      data: { status: 'running', pending: Prisma.DbNull, transcript: json(history) },
    });
    if (claimed.count === 0) throw new AgentStateError('This decision was already made, or the run has stopped.');
    const ordinal = await tx.agentStep.count({ where: { runId } });
    await tx.agentStep.create({ data: { runId, ordinal, kind: 'tool_result', tool, output: json(decision) } });
    await appendAudit(tx, { entityType: 'agent_run', entityId: runId, ...auditEvent });
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
