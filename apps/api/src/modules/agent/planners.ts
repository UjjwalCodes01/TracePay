import type { Content, Part } from '@google/genai';
import { aiReady } from '../../config/env';
import { vertex } from '../../integrations/ai/vertex';
import { SHOPPER_SYSTEM_PROMPT, SHOPPER_TOOL_DECLARATIONS } from './buyer-tools';
import { TOOL_DECLARATIONS } from './tools';

/** Who the run works for: the Publisher Agent, or the buyer's Shopping Assistant. */
export type RunKind = 'publisher' | 'buyer';

/** Provider-neutral history, persisted on the run so a paused run can resume. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentMessage =
  | { role: 'user'; text: string }
  | { role: 'model'; text: string | null; calls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: Array<{ id: string; name: string; response: Record<string, unknown> }> };

export interface PlannerTurn {
  text: string | null;
  calls: ToolCall[];
  /** Provider-native message parts, replayed verbatim on the next turn. */
  raw?: unknown;
}

export interface AgentPlanner {
  readonly name: string;
  readonly model: string;
  next(history: AgentMessage[], kind?: RunKind): Promise<PlannerTurn>;
}

export const AGENT_SYSTEM_PROMPT = [
  'You are the Publisher Agent for TracePay, working for a research studio that sells AI-generated reports built from licensed sources.',
  'Your job: turn the publisher’s goal into a sellable report whose every source is licensed for the intended use.',
  'Process: run_license_preflight on the publisher’s selection first. If it is blocked, find_compatible_replacement for each failing source and propose_replacement with the best compatible candidate, then preflight again. Once preflight passes: generate_report, validate_provenance, prepare_sale. Finish with a short summary for the publisher.',
  'Hard rules:',
  '- The license compiler’s decision is final. Never try to work around a failed rule; replace the source instead.',
  '- Only preflight the publisher’s selection and replacements that were approved.',
  '- You cannot change the price, purpose or distribution, and you cannot move money.',
  '- If a replacement is rejected, stop and explain what the publisher can do.',
  'Explain decisions in one or two plain sentences. Never invent sources, ids or license terms.',
].join('\n');

// ---------------------------------------------------------------- Gemini (API key or Vertex AI)

export class GeminiPlanner implements AgentPlanner {
  readonly name = 'gemini';
  readonly model: string;

  constructor() {
    this.model = vertex().model;
  }

  async next(history: AgentMessage[], kind: RunKind = 'publisher'): Promise<PlannerTurn> {
    const { ai, model } = vertex();
    const tools = kind === 'buyer' ? SHOPPER_TOOL_DECLARATIONS : TOOL_DECLARATIONS;
    const response = await ai.models.generateContent({
      model,
      contents: toContents(history),
      config: {
        systemInstruction: kind === 'buyer' ? SHOPPER_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT,
        temperature: 0,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      },
    });
    const parts: Part[] = response.candidates?.[0]?.content?.parts ?? [];
    const calls = (response.functionCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${history.length}_${i}`,
      name: c.name ?? 'unknown',
      args: (c.args ?? {}) as Record<string, unknown>,
    }));
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim() || null;
    return { text, calls, raw: parts };
  }
}

function toContents(history: AgentMessage[]): Content[] {
  return history.map((m): Content => {
    switch (m.role) {
      case 'user':
        return { role: 'user', parts: [{ text: m.text }] };
      case 'model':
        // Replaying the provider's own parts keeps any thought signatures intact.
        return {
          role: 'model',
          parts: (m.raw as Part[] | undefined) ?? [
            ...(m.text ? [{ text: m.text }] : []),
            ...m.calls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } })),
          ],
        };
      case 'tool':
        return { role: 'user', parts: m.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: r.response } })) };
    }
  });
}

// ---------------------------------------------------------------- Rule-based fallback

/**
 * Deterministic planner used when Vertex AI is not configured. It follows the
 * same tools and guardrails with a fixed policy, and is labeled as such in the
 * UI — it is never presented as model output.
 */
export class RuleBasedPlanner implements AgentPlanner {
  readonly name = 'rule-based';
  readonly model = 'rule-based-planner/1';
  private n = 0;

  async next(history: AgentMessage[], kind: RunKind = 'publisher'): Promise<PlannerTurn> {
    if (kind === 'buyer') return shopperRules(history);
    const call = (name: string, args: Record<string, unknown> = {}, text: string | null = null): PlannerTurn => ({
      text,
      calls: [{ id: `rb_${++this.n}_${history.length}`, name, args }],
    });
    const done = (text: string): PlannerTurn => ({ text, calls: [] });

    const results = history.flatMap((m) => (m.role === 'tool' ? m.results : []));
    const last = results.at(-1);
    const selection = (history.find((m) => m.role === 'user') as { text: string } | undefined)?.text.match(/SELECTION=(\S+)/)?.[1]?.split(',') ?? [];
    const replacements: Record<string, string> = {};
    for (const m of history) {
      if (m.role !== 'model') continue;
      for (const c of m.calls) if (c.name === 'propose_replacement') replacements[c.args.blockedAssetVersionId as string] = c.args.replacementAssetVersionId as string;
    }

    if (!last) return call('run_license_preflight', { assetVersionIds: selection }, 'Checking the selected sources against the intended commercial use.');
    const r = last.response;
    if (r.error) return done(`Stopped: ${String(r.message)}`);

    switch (last.name) {
      case 'run_license_preflight': {
        if (r.verdict === 'pass') return call('generate_report', { buildId: r.buildId }, 'Preflight passed. Generating the report from approved sources only.');
        const failed = (r.failedRules as Array<{ assetVersionId: string | null }>).find((f) => f.assetVersionId && !(f.assetVersionId in replacements));
        if (!failed?.assetVersionId) return done('Preflight is blocked by build-level terms that a source replacement cannot fix.');
        return call('find_compatible_replacement', { blockedAssetVersionId: failed.assetVersionId }, `Preflight blocked ${failed.assetVersionId}. Looking for a compatible replacement.`);
      }
      case 'find_compatible_replacement': {
        const best = (r.candidates as Array<{ assetVersionId: string; title: string; compatible: boolean; economics?: string }>).find((c) => c.compatible);
        if (!best) return done(`No compatible replacement exists for ${String(r.blockedAssetVersionId)}. The publisher needs to license another source.`);
        return call('propose_replacement', {
          blockedAssetVersionId: r.blockedAssetVersionId,
          replacementAssetVersionId: best.assetVersionId,
          reason: `"${best.title}" permits commercial derivative reports (${best.economics ?? 'see terms'}).`,
        });
      }
      case 'propose_replacement': {
        if (r.approved !== true) return done('The publisher declined the replacement, so the build stops here.');
        const next = selection.map((id) => replacements[id] ?? id);
        return call('run_license_preflight', { assetVersionIds: next }, 'Replacement approved. Re-running preflight.');
      }
      case 'generate_report':
        if (!r.artifactId) return done('Generation was rejected by the citation validator; no artifact was listed.');
        return call('validate_provenance', { artifactId: r.artifactId });
      case 'validate_provenance': {
        const artifactId = [...results].reverse().find((x) => x.name === 'generate_report')?.response.artifactId;
        return call('prepare_sale', { artifactId });
      }
      case 'prepare_sale':
        return done(`The report is listed at $${((r.priceCents as number) / 100).toFixed(2)} with verified provenance and ready for PayPal checkout.`);
      default:
        return done('Finished.');
    }
  }
}

// The rule-based Shopping Assistant: search, inspect the best affordable match (then the
// next one if it doesn't check out), propose it, and report back. Labeled as such.
function shopperRules(history: AgentMessage[]): PlannerTurn {
  const call = (name: string, args: Record<string, unknown>, text: string | null = null): PlannerTurn => ({
    text,
    calls: [{ id: `rb_shop_${history.length}_${name}`, name, args }],
  });
  const done = (text: string): PlannerTurn => ({ text, calls: [] });
  const goal = ((history.find((m) => m.role === 'user') as { text: string } | undefined)?.text ?? '').split('\n')[0]!;
  const results = history.flatMap((m) => (m.role === 'tool' ? m.results : []));
  const last = results.at(-1);
  if (!last) return call('search_reports', { query: goal }, 'Searching the store for reports that match what you need.');

  type Hit = { reportId: string; title: string; fitsBudget: boolean; match: number; price: string };
  const search = [...results].reverse().find((r) => r.name === 'search_reports')?.response as { reports?: Hit[]; remainingBudget?: string } | undefined;
  const inspected = new Set(results.filter((r) => r.name === 'inspect_report').map((r) => String(r.response.reportId)));
  const nextCandidate = () => (search?.reports ?? []).find((h) => h.fitsBudget && h.match > 0 && !inspected.has(h.reportId));
  const r = last.response;

  switch (last.name) {
    case 'search_reports':
    case 'inspect_report': {
      if (last.name === 'inspect_report' && !r.error) {
        const fine = r.forSale && !r.alreadyOwned && r.fitsBudget && r.licensesValidToday && r.citationsCheckOut;
        if (fine) {
          return call('propose_purchase', {
            reportId: r.reportId,
            reason: `"${String(r.title)}" matches what you asked for, costs ${String(r.price)} (within your budget), every source is licensed for sale today, and all ${String(r.citations)} citations check out.`,
          });
        }
      }
      const hit = nextCandidate();
      if (hit) return call('inspect_report', { reportId: hit.reportId }, `Checking "${hit.title}" (${hit.price}): its sources, citations and licenses.`);
      const anyMatch = (search?.reports ?? []).some((h) => h.match > 0);
      return done(
        anyMatch
          ? `I found matching reports, but none fits your remaining budget of ${search?.remainingBudget ?? 'this run'} and checks out. Try a higher budget.`
          : 'I couldn’t find a report in the store that matches what you asked for. Try describing it in other words.',
      );
    }
    case 'propose_purchase':
      if (r.purchased === true) return done(`Done: you bought the report for ${String(r.amount)}. It’s unlocked in the store, with its receipt. Budget left: ${String(r.remainingBudget)}.`);
      if (r.error) return done(`I couldn’t propose that purchase: ${String(r.message)}`);
      return done('Okay — nothing was bought. Your budget is untouched.');
    default:
      return done('Finished.');
  }
}

export function pickPlanner(mode = process.env.GENERATION_MODE ?? 'auto'): AgentPlanner {
  if (mode === 'fixture') return new RuleBasedPlanner();
  return mode === 'vertex' || aiReady() ? new GeminiPlanner() : new RuleBasedPlanner();
}
