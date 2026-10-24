import { beforeEach, describe, expect, it } from 'vitest';
import type { BuildIntent } from '@tracepay/shared';
import { db } from '../../src/db';
import { createRun, decideReplacement, MAX_AGENT_TURNS, runAgent } from '../../src/modules/agent/agent.service';
import { RuleBasedPlanner, type AgentMessage, type AgentPlanner, type PlannerTurn } from '../../src/modules/agent/planners';
import { resetAndSeed } from '../../src/modules/demo/seed';
import { DEMO_IDS } from '../../src/modules/demo/world';
import { FixtureReportWriter } from '../../src/modules/generation/writers';

const A = 'asset_northwind_index_v1';
const B = 'asset_okafor_notes_v1';
const C = 'asset_kestrel_panel_v1';
const D = 'asset_lumen_digest_v1';
/** The most relevant compatible replacement for the brief: a real CC BY paper (free, with a credit line). */
const R = 'asset_arxiv_dohmke_2023_v1';
const E = 'asset_ide_pricing_v1';
const AS_OF = '2026-10-18';

const intent: BuildIntent = {
  title: 'Developer Tools Market Brief, Q4 2026',
  brief: 'Developer-tools spend, AI coding assistant adoption, trust and pricing.',
  purpose: 'commercial_report',
  distribution: 'sale',
  includesRawData: false,
  territory: 'US',
  priceCents: 2000,
  currency: 'USD',
};
const goal = 'Create a commercial developer-tools market report using approved sources. Find a compatible replacement if any source fails licensing checks.';
const writer = new FixtureReportWriter();

async function start(planner: AgentPlanner, autoReplace: boolean, selection = [A, B, C]) {
  const run = await createRun(db(), planner, { publisherId: DEMO_IDS.publisher, goal, intent, selection, policy: { autoReplace } });
  await runAgent(db(), planner, writer, run.id, { asOf: AS_OF });
  return run.id;
}

const tools = async (runId: string) =>
  (await db().agentStep.findMany({ where: { runId, kind: 'tool_call' }, orderBy: { ordinal: 'asc' } })).map((s) => s.tool);

/** A planner that replays a fixed script of calls, to probe guardrails. */
class ScriptedPlanner implements AgentPlanner {
  readonly name = 'scripted';
  readonly model = 'test';
  constructor(private script: Array<PlannerTurn | ((h: AgentMessage[]) => PlannerTurn)>) {}
  async next(history: AgentMessage[]) {
    const s = this.script.shift();
    if (!s) return { text: 'done', calls: [] };
    return typeof s === 'function' ? s(history) : s;
  }
}
const lastResponse = (h: AgentMessage[]) => (h.at(-1) as Extract<AgentMessage, { role: 'tool' }>).results.at(-1)!.response;

describe.runIf(process.env.TEST_DATABASE_URL)('publisher agent (integration)', () => {
  beforeEach(async () => {
    await resetAndSeed(db());
  });

  it('recovers from a blocked plan by substituting a compatible source (pre-authorised)', async () => {
    const runId = await start(new RuleBasedPlanner(), true);
    const run = await db().agentRun.findUniqueOrThrow({ where: { id: runId }, include: { builds: { orderBy: { createdAt: 'asc' }, include: { sources: { orderBy: { ordinal: 'asc' } } } } } });
    expect(run.status).toBe('completed');
    expect(await tools(runId)).toEqual([
      'run_license_preflight',
      'find_compatible_replacement',
      'propose_replacement',
      'run_license_preflight',
      'generate_report',
      'validate_provenance',
      'prepare_sale',
    ]);
    expect(run.builds.map((b) => b.status)).toEqual(['preflight_blocked', 'generated']);
    expect(run.builds[1]!.sources.map((s) => s.assetVersionId)).toEqual([A, B, R]); // C → R, the expired and non-commercial ones never chosen
    expect(run.summary).toMatch(/listed at \$20\.00/);
  });

  it('pauses for the publisher’s approval, then continues once approved', async () => {
    const planner = new RuleBasedPlanner();
    const runId = await start(planner, false);
    let run = await db().agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('awaiting_approval');
    expect(run.pending).toMatchObject({ blockedAssetVersionId: C, replacementAssetVersionId: R });
    expect(await db().artifact.count()).toBe(0);

    await decideReplacement(db(), runId, DEMO_IDS.publisher, true);
    await runAgent(db(), planner, writer, runId, { asOf: AS_OF });
    run = await db().agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('completed');
    expect(await db().artifact.count()).toBe(1);
  });

  it('stops without a build when the publisher declines the replacement', async () => {
    const planner = new RuleBasedPlanner();
    const runId = await start(planner, false);
    await decideReplacement(db(), runId, DEMO_IDS.publisher, false);
    await runAgent(db(), planner, writer, runId, { asOf: AS_OF });
    const run = await db().agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('completed');
    expect(run.summary).toMatch(/declined/);
    expect(await db().artifact.count()).toBe(0);
  });

  it('enforces guardrails the model cannot talk its way around', async () => {
    const otherRun = await start(new RuleBasedPlanner(), true, [A, B, D]);
    const foreignBuild = (await db().buildJob.findFirstOrThrow({ where: { agentRunId: otherRun, status: 'generated' } })).id;

    const responses: Record<string, unknown>[] = [];
    const planner = new ScriptedPlanner([
      { text: null, calls: [{ id: '1', name: 'run_license_preflight', args: { assetVersionIds: [A, B, E] } }] },
      (h) => (responses.push(lastResponse(h)), { text: null, calls: [{ id: '2', name: 'generate_report', args: { buildId: foreignBuild } }] }),
      (h) => (responses.push(lastResponse(h)), { text: null, calls: [{ id: '3', name: 'approve_settlement', args: {} }] }),
      (h) => (responses.push(lastResponse(h)), { text: null, calls: [{ id: '4', name: 'propose_replacement', args: { blockedAssetVersionId: E, replacementAssetVersionId: D, reason: 'x' } }] }),
      (h) => (responses.push(lastResponse(h)), { text: 'gave up', calls: [] }),
    ]);
    await start(planner, true, [A, B, C]);
    expect(responses.map((r) => r.error)).toEqual(['GUARDRAIL', 'GUARDRAIL', 'UNKNOWN_TOOL', 'GUARDRAIL']);
  });

  it('shows people plain text with titles, while the model’s transcript stays verbatim', async () => {
    const dohmke = '“Sea Change in Software Development (Dohmke, Iansiti & Richards, 2023)”';
    const kestrel = '“Kestrel Enterprise Engineering Panel 2026”';
    const lookUp = { text: null, calls: [{ id: '1', name: 'find_compatible_replacement', args: { blockedAssetVersionId: C } }] };
    const proposing = await start(new ScriptedPlanner([lookUp, { text: null, calls: [{ id: '2', name: 'propose_replacement', args: { blockedAssetVersionId: C, replacementAssetVersionId: R, reason: `**Swap** ${C} for "${R}".` } }] }]), false);
    const paused = await db().agentRun.findUniqueOrThrow({ where: { id: proposing } });
    expect(paused.status).toBe('awaiting_approval');
    expect((paused.pending as { reason: string }).reason).toBe(`Swap ${kestrel} for ${dohmke}.`);

    const finishing = await start(new ScriptedPlanner([lookUp, { text: `### Done\n**Stopped** before using ${R}.`, calls: [] }]), true);
    const done = await db().agentRun.findUniqueOrThrow({ where: { id: finishing } });
    expect(done.summary).toBe(`Done\nStopped before using ${dohmke}.`);
    expect(JSON.stringify(done.transcript)).toContain(`**Stopped** before using ${R}.`);
  });

  it('stops at the turn limit', async () => {
    const loop: AgentPlanner = { name: 'loop', model: 'test', next: async () => ({ text: null, calls: [{ id: 'x', name: 'find_approved_sources', args: {} }] }) };
    const runId = await start(loop, true);
    const run = await db().agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('failed');
    expect(await db().agentStep.count({ where: { runId, kind: 'tool_call' } })).toBe(MAX_AGENT_TURNS);
  });
});
