import { sameWorld } from '../demo/world';
import { formatMoney } from '@tracepay/shared';
import type { Db } from '../../db';
import type { CitationReport } from '../generation/citations';
import type { ArtifactContent } from '../generation/generation.service';
import { checkSaleRights } from '../sales/rights.service';
import type { AgentMessage } from './planners';
import type { ToolDeclaration } from './tools';

/**
 * The Shopping Assistant: it works for a BUYER. It can search the store, check a
 * report's licenses and sources, and propose one purchase. It can never pay: the
 * buyer approves every payment in PayPal, and the budget is enforced here, not by
 * the model.
 */
export interface ShopperPolicy {
  /** The most the buyer will spend in this run, in cents. */
  budgetCents: number;
  /** How many reports the assistant may propose buying in this run. */
  maxPurchases: number;
  /** A hosted demo's shared buyer: earlier visitors' purchases don't count as owned, only this run's. */
  repeatPurchases?: boolean;
}

export interface ShopperContext {
  db: Db;
  runId: string;
  buyerId: string;
  policy: ShopperPolicy;
  /** Purchases completed in this run so far. */
  purchases: Array<{ artifactId: string; amountCents: number }>;
}

export interface PurchaseApproval {
  type: 'purchase';
  artifactId: string;
  title: string;
  priceCents: number;
  currency: string;
  reason: string;
}

export type ShopperToolResult =
  | { kind: 'result'; response: Record<string, unknown> }
  | { kind: 'pause'; response: Record<string, unknown>; approval: PurchaseApproval };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });

/** The only capabilities the assistant has. None of them moves money. */
export const SHOPPER_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'search_reports',
    description:
      'Search the reports for sale. Returns each report’s id, title, summary, price, whether it fits the remaining budget, and how well it matches the query. Reports the buyer already owns are left out.',
    parameters: obj({ query: str('What the buyer is looking for, in a few words.') }),
  },
  {
    name: 'inspect_report',
    description:
      'Look closely at one report before recommending it: its sections, the sources it was built from, whether every citation checks out, and a fresh license check (are all its sources still licensed for sale today?).',
    parameters: obj({ reportId: str('A report id from search_reports.') }, ['reportId']),
  },
  {
    name: 'propose_purchase',
    description:
      'Ask the buyer to buy one report. The buyer sees your reason and approves (or declines) the payment in PayPal themselves; you cannot pay. Refused if the report is over the remaining budget, not for sale, already owned, or its licenses no longer permit the sale.',
    parameters: obj(
      { reportId: str('The report to buy.'), reason: str('One or two plain sentences: why this report fits what the buyer asked for.') },
      ['reportId', 'reason'],
    ),
  },
];

export const SHOPPER_SYSTEM_PROMPT = [
  'You are the Shopping Assistant for TracePay, working for a BUYER of research reports.',
  'Every report in the store was built only from licensed sources, and part of each sale is paid to the people whose work it uses.',
  'Process: search_reports for what the buyer needs. inspect_report on the best match (and on alternatives if it doesn’t check out). Then propose_purchase for the single best report that fits the budget, with a short reason. After the buyer decides, finish with a short summary.',
  'Hard rules:',
  '- Never propose a report over the remaining budget, one whose license check fails, or one whose citations don’t check out.',
  '- Propose at most the number of purchases the buyer allowed, one at a time.',
  '- You cannot pay or change prices. The buyer approves every payment in PayPal.',
  '- If nothing fits, say so plainly and suggest what the buyer could change (budget or wording). Do not propose something that doesn’t fit just to buy something.',
  'Write for a non-technical reader. Never invent reports, ids or prices.',
].join('\n');

const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const STOP = new Set(['the', 'and', 'for', 'with', 'about', 'that', 'this', 'want', 'need', 'report', 'reports', 'find', 'buy', 'some', 'any', 'under', 'please', 'looking']);

/** How well a report's title and summary match the query: 0–1, simple word overlap. */
export function matchScore(query: string, text: string): number {
  const q = [...tokens(query)].filter((t) => !STOP.has(t));
  if (!q.length) return 0;
  const t = tokens(text);
  return Math.round((q.filter((w) => t.has(w) || [...t].some((x) => x.startsWith(w) || w.startsWith(x))).length / q.length) * 100) / 100;
}

const summaryOf = (content: ArtifactContent) => content.sections.find((s) => (s as { key?: string }).key === 'summary')?.body ?? content.sections[0]?.body ?? '';
const spent = (ctx: ShopperContext) => ctx.purchases.reduce((n, p) => n + p.amountCents, 0);
export const remainingBudget = (ctx: ShopperContext) => Math.max(0, ctx.policy.budgetCents - spent(ctx));

class ToolInputError extends Error {}
const asString = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolInputError(`"${key}" must be a non-empty string.`);
  return v.trim();
};

async function owned(ctx: ShopperContext, artifactId: string) {
  if (ctx.policy.repeatPurchases) return ctx.purchases.some((p) => p.artifactId === artifactId);
  return (await ctx.db.sale.count({ where: { artifactId, buyerId: ctx.buyerId, status: 'captured' } })) > 0;
}

export async function executeShopperTool(ctx: ShopperContext, name: string, args: Record<string, unknown>): Promise<ShopperToolResult> {
  const ok = (response: Record<string, unknown>): ShopperToolResult => ({ kind: 'result', response });
  try {
    switch (name) {
      case 'search_reports': {
        const query = typeof args.query === 'string' ? args.query.slice(0, 200) : '';
        const ownedIds = new Set(
          ctx.policy.repeatPurchases
            ? ctx.purchases.map((p) => p.artifactId)
            : (await ctx.db.sale.findMany({ where: { buyerId: ctx.buyerId, status: 'captured' }, select: { artifactId: true } })).map((s) => s.artifactId),
        );
        const listed = await ctx.db.artifact.findMany({ where: { status: 'listed', buildJob: { publisherId: sameWorld(ctx.buyerId) } }, orderBy: { createdAt: 'desc' }, take: 100 });
        const left = remainingBudget(ctx);
        const reports = listed
          .filter((a) => !ownedIds.has(a.id))
          .map((a) => {
            const content = a.content as unknown as ArtifactContent;
            const summary = summaryOf(content);
            return {
              reportId: a.id,
              title: a.title,
              summary: summary.slice(0, 400),
              price: formatMoney(a.priceCents),
              priceCents: a.priceCents,
              fitsBudget: a.priceCents <= left,
              match: matchScore(query, `${a.title} ${summary}`),
              sources: content.sources.length,
            };
          })
          .sort((x, y) => y.match - x.match || Number(y.fitsBudget) - Number(x.fitsBudget) || x.priceCents - y.priceCents)
          .slice(0, 20);
        return ok({ remainingBudget: formatMoney(left), remainingBudgetCents: left, alreadyOwned: ownedIds.size, reports });
      }

      case 'inspect_report': {
        const id = asString(args, 'reportId');
        const a = await ctx.db.artifact.findUnique({ where: { id } });
        if (!a) return ok({ error: 'NOT_FOUND', message: `No report ${id}.` });
        const content = a.content as unknown as ArtifactContent;
        const citations = a.citationReport as unknown as CitationReport | null;
        const listed = a.status === 'listed';
        // The same deterministic license check that runs before every sale, as of today.
        const rights = listed ? await ctx.db.$transaction((tx) => checkSaleRights(tx, id)) : null;
        return ok({
          reportId: a.id,
          title: a.title,
          price: formatMoney(a.priceCents),
          priceCents: a.priceCents,
          forSale: listed,
          alreadyOwned: await owned(ctx, id),
          fitsBudget: a.priceCents <= remainingBudget(ctx),
          sections: content.sections.map((s) => s.heading),
          sources: content.sources.map((s) => ({ title: s.assetTitle, cited: s.cited })),
          citationsCheckOut: citations?.ok ?? false,
          citations: citations?.citations.length ?? 0,
          licensesValidToday: rights?.ok ?? false,
          licenseProblems: rights && !rights.ok ? rights.reasons : [],
          writtenBy: a.fromFixture ? 'extractive fallback (no AI model)' : a.model,
        });
      }

      case 'propose_purchase': {
        const id = asString(args, 'reportId');
        const reason = asString(args, 'reason').slice(0, 600);
        if (ctx.purchases.length >= ctx.policy.maxPurchases) {
          return ok({ error: 'GUARDRAIL', message: `The buyer allowed ${ctx.policy.maxPurchases} purchase(s) in this run, and that many are done.` });
        }
        const a = await ctx.db.artifact.findUnique({ where: { id }, select: { id: true, title: true, priceCents: true, currency: true, status: true, citationReport: true } });
        if (!a) return ok({ error: 'NOT_FOUND', message: `No report ${id}.` });
        if (a.status !== 'listed') return ok({ error: 'GUARDRAIL', message: 'That report is not for sale right now.' });
        if (await owned(ctx, id)) return ok({ error: 'GUARDRAIL', message: 'The buyer already owns that report.' });
        const left = remainingBudget(ctx);
        if (a.priceCents > left) {
          return ok({ error: 'GUARDRAIL', message: `It costs ${formatMoney(a.priceCents)}, over the remaining budget of ${formatMoney(left)}.` });
        }
        if (!(a.citationReport as unknown as CitationReport | null)?.ok) return ok({ error: 'GUARDRAIL', message: 'That report’s citations don’t check out.' });
        const rights = await ctx.db.$transaction((tx) => checkSaleRights(tx, id));
        if (!rights.ok) return ok({ error: 'GUARDRAIL', message: `Its licenses don’t permit a sale today: ${rights.reasons[0]}` });
        return {
          kind: 'pause',
          response: { status: 'awaiting_buyer_approval' },
          approval: { type: 'purchase', artifactId: a.id, title: a.title, priceCents: a.priceCents, currency: a.currency, reason },
        };
      }

      default:
        return ok({ error: 'UNKNOWN_TOOL', message: `No tool named "${name}".` });
    }
  } catch (err) {
    if (err instanceof ToolInputError) return ok({ error: 'BAD_INPUT', message: err.message });
    return ok({ error: 'TOOL_FAILED', message: (err as Error).message });
  }
}

/** Purchases completed in a run, read back from its transcript. */
export function purchasesFrom(history: AgentMessage[]): ShopperContext['purchases'] {
  return history.flatMap((m) =>
    m.role === 'tool'
      ? m.results
          .filter((r) => r.name === 'propose_purchase' && r.response.purchased === true)
          .map((r) => ({ artifactId: String(r.response.reportId), amountCents: Number(r.response.amountCents) || 0 }))
      : [],
  );
}
