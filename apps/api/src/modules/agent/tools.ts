import { retrievePassages } from '../generation/retrieval';
import type { BuildIntent } from '@tracepay/shared';
import { formatBps, formatMoney } from '@tracepay/shared';
import type { Db } from '../../db';
import { listCatalog, resolveSources, type CatalogEntry } from '../catalog/catalog.service';
import { preflightAndRecord, todayUtc } from '../builds/preflight.service';
import { failedRules, runPreflight } from '../license-compiler/compiler';
import { generateArtifact } from '../generation/generation.service';
import type { ReportWriter } from '../generation/writers';
import type { CitationReport } from '../generation/citations';

export interface AgentPolicy {
  /** Publisher pre-authorised the agent to swap in a compatible replacement without asking. */
  autoReplace: boolean;
}

export interface ToolContext {
  db: Db;
  runId: string;
  publisherId: string;
  intent: BuildIntent;
  policy: AgentPolicy;
  /** The publisher's original selection. */
  selection: string[];
  /** Replacements the publisher (or policy) approved: blocked → replacement. */
  approvedReplacements: Record<string, string>;
  writer: ReportWriter;
  asOf?: string;
}

export type ToolResult =
  | { kind: 'result'; response: Record<string, unknown> }
  | { kind: 'pause'; response: Record<string, unknown>; approval: PendingApproval };

export interface PendingApproval {
  blockedAssetVersionId: string;
  replacementAssetVersionId: string;
  reason: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });

/** The only capabilities the agent has. None of them can move money or edit licenses. */
export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'find_approved_sources',
    description: 'List the licensed sources in the publisher’s catalog with a summary of each license’s permissions and economics.',
    parameters: obj({}),
  },
  {
    name: 'run_license_preflight',
    description:
      'Run the deterministic license compiler on a set of source versions for the publisher’s fixed intent. Only sources the publisher selected, or replacements already approved, may be included. Returns pass/block and the failed rules. You cannot override a failed rule.',
    parameters: obj({ assetVersionIds: { type: 'array', items: { type: 'string' }, description: 'Asset version ids to include.' } }, ['assetVersionIds']),
  },
  {
    name: 'find_compatible_replacement',
    description:
      'For a source that failed the license check, find catalog sources that would make the report pass. Each candidate comes with how relevant its content is to the report’s brief (0–1), what it would cost per sale, and its license. Choose the one that best serves the brief at a sensible cost — a cheap but off-topic source makes a worse report.',
    parameters: obj({ blockedAssetVersionId: str('The asset version that failed preflight.') }, ['blockedAssetVersionId']),
  },
  {
    name: 'propose_replacement',
    description:
      'Ask to substitute a blocked source with a compatible one. Approved automatically only if the publisher pre-authorised replacements; otherwise the run pauses for the publisher’s decision.',
    parameters: obj(
      {
        blockedAssetVersionId: str('The source to remove.'),
        replacementAssetVersionId: str('The compatible source to use instead.'),
        reason: str('One sentence explaining the substitution to the publisher.'),
      },
      ['blockedAssetVersionId', 'replacementAssetVersionId', 'reason'],
    ),
  },
  {
    name: 'generate_report',
    description: 'Generate the deliverable for a build that passed preflight. Every citation is validated against retrieval records.',
    parameters: obj({ buildId: str('A build id returned by a passing run_license_preflight.') }, ['buildId']),
  },
  {
    name: 'validate_provenance',
    description: 'Check an artifact’s citations: which sources were cited, which were retrieved but not cited, and whether every citation resolves.',
    parameters: obj({ artifactId: str('The artifact id.') }, ['artifactId']),
  },
  {
    name: 'prepare_sale',
    description: 'Confirm the artifact is listed for sale at the publisher’s price and return its storefront details. Does not charge anyone.',
    parameters: obj({ artifactId: str('The artifact id.') }, ['artifactId']),
  },
];

const summarizeLicense = (e: CatalogEntry) => {
  const t = e.license?.terms;
  if (!e.license || !t) return { license: 'none' };
  return {
    licenseStatus: e.license.status,
    ...(t.licenseName ? { licenseName: t.licenseName } : {}),
    commercialUse: t.commercialUse,
    purposes: t.allowedPurposes,
    derivativeReports: t.derivativeReports,
    rawRedistribution: t.rawRedistribution,
    validUntil: t.validUntil,
    economics:
      t.economics.kind === 'percent_of_gross' ? `${formatBps(t.economics.bps)} of each sale` : t.economics.kind === 'fixed_per_sale' ? `${formatMoney(t.economics.amountCents)} per sale` : 'none',
    payableOn: t.payableOn,
  };
};

class ToolInputError extends Error {}

const asString = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new ToolInputError(`"${key}" must be a non-empty string.`);
  return v;
};

/** The set the agent is currently allowed to preflight. */
export function allowedSources(ctx: ToolContext): Set<string> {
  return new Set([...ctx.selection, ...Object.values(ctx.approvedReplacements)]);
}

export async function executeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const ok = (response: Record<string, unknown>): ToolResult => ({ kind: 'result', response });
  try {
    switch (name) {
      case 'find_approved_sources': {
        const catalog = await listCatalog(ctx.db, ctx.publisherId);
        return ok({
          intent: { purpose: ctx.intent.purpose, distribution: ctx.intent.distribution, priceCents: ctx.intent.priceCents, territory: ctx.intent.territory },
          publisherSelection: ctx.selection,
          sources: catalog.map((e) => ({ assetVersionId: e.assetVersionId, title: e.assetTitle, kind: e.kind, owner: e.owner.name, ...summarizeLicense(e) })),
        });
      }

      case 'run_license_preflight': {
        const ids = args.assetVersionIds;
        if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new ToolInputError('"assetVersionIds" must be an array of strings.');
        const allowed = allowedSources(ctx);
        const unauthorised = (ids as string[]).filter((i) => !allowed.has(i));
        if (unauthorised.length) {
          return ok({
            error: 'GUARDRAIL',
            message: `Not authorised to use ${unauthorised.join(', ')}. Only the publisher's selection and approved replacements may be preflighted.`,
          });
        }
        const outcome = await ctx.db.$transaction((tx) =>
          preflightAndRecord(tx, { publisherId: ctx.publisherId, intent: ctx.intent, assetVersionIds: ids as string[], agentRunId: ctx.runId, asOf: ctx.asOf }),
        );
        return ok({
          buildId: outcome.buildId,
          verdict: outcome.report.verdict,
          failedRules: failedRules(outcome.report).map((r) => ({ ruleId: r.ruleId, assetVersionId: r.assetVersionId ?? null, message: r.message })),
          obligations: outcome.report.obligations.map((o) => o.text),
          economics: outcome.report.economics,
        });
      }

      case 'find_compatible_replacement': {
        const blocked = asString(args, 'blockedAssetVersionId');
        const current = [...allowedSources(ctx)].filter((id) => id !== blocked && !(id in ctx.approvedReplacements));
        const catalog = await listCatalog(ctx.db, ctx.publisherId);
        const candidates = catalog.filter((e) => !allowedSources(ctx).has(e.assetVersionId) && e.assetVersionId !== blocked);
        const asOf = ctx.asOf ?? todayUtc();
        const evaluated = [];
        // How well each candidate's content fits the brief: its best passage's text-search rank.
        const brief = `${ctx.intent.title} ${ctx.intent.brief}`;
        const ranked = candidates.length ? await retrievePassages(ctx.db, candidates.map((c) => c.assetVersionId), brief, 1) : [];
        const rankOf = new Map(ranked.map((p) => [p.assetVersionId, p.rank]));
        const top = Math.max(0, ...ranked.map((p) => p.rank));
        for (const c of candidates) {
          const sources = await resolveSources(ctx.db, ctx.publisherId, [...current, c.assetVersionId]);
          const report = runPreflight({ intent: ctx.intent, sources, asOf });
          const own = failedRules(report).filter((r) => r.assetVersionId === c.assetVersionId || !r.assetVersionId);
          evaluated.push({
            assetVersionId: c.assetVersionId,
            title: c.assetTitle,
            compatible: own.length === 0,
            reasons: own.map((r) => r.message),
            ...summarizeLicense(c),
            relevance: top > 0 ? Math.round(((rankOf.get(c.assetVersionId) ?? 0) / top) * 100) / 100 : 0,
            maxContributorCents: report.economics.maxContributorCents,
          });
        }
        // Compatible first; then the best fit for the brief (in steps of 0.1, so near-ties go to the cheaper); then cost.
        evaluated.sort(
          (a, b) => Number(b.compatible) - Number(a.compatible) || Math.round(b.relevance * 10) - Math.round(a.relevance * 10) || a.maxContributorCents - b.maxContributorCents,
        );
        return ok({ blockedAssetVersionId: blocked, blockedTitle: catalog.find((e) => e.assetVersionId === blocked)?.assetTitle ?? null, candidates: evaluated });
      }

      case 'propose_replacement': {
        const blocked = asString(args, 'blockedAssetVersionId');
        const replacement = asString(args, 'replacementAssetVersionId');
        const reason = asString(args, 'reason');
        if (!ctx.selection.includes(blocked)) return ok({ error: 'GUARDRAIL', message: `${blocked} is not in the publisher's selection.` });
        const exists = await ctx.db.assetVersion.count({ where: { id: replacement } });
        if (!exists) return ok({ error: 'NOT_FOUND', message: `${replacement} is not in the catalog.` });
        if (ctx.policy.autoReplace) {
          ctx.approvedReplacements[blocked] = replacement;
          return ok({ approved: true, by: 'policy', message: 'Publisher pre-authorised compatible replacements.' });
        }
        return {
          kind: 'pause',
          response: { status: 'awaiting_publisher_approval' },
          approval: { blockedAssetVersionId: blocked, replacementAssetVersionId: replacement, reason },
        };
      }

      case 'generate_report': {
        const buildId = asString(args, 'buildId');
        const build = await ctx.db.buildJob.findUnique({ where: { id: buildId }, select: { agentRunId: true } });
        if (!build || build.agentRunId !== ctx.runId) return ok({ error: 'GUARDRAIL', message: 'You can only generate builds created in this run.' });
        const result = await generateArtifact(ctx.db, buildId, ctx.writer);
        return ok({
          artifactId: result.artifactId,
          citationsValid: result.citationReport.ok,
          citationErrors: result.citationReport.errors.map((e) => e.message),
          model: result.model,
          fromFixture: result.fromFixture,
        });
      }

      case 'validate_provenance': {
        const artifactId = asString(args, 'artifactId');
        const artifact = await ctx.db.artifact.findUnique({ where: { id: artifactId }, include: { buildJob: { select: { agentRunId: true } } } });
        if (!artifact || artifact.buildJob.agentRunId !== ctx.runId) return ok({ error: 'NOT_FOUND', message: 'Unknown artifact for this run.' });
        const report = artifact.citationReport as unknown as CitationReport;
        return ok({
          ok: report.ok,
          citations: report.citations.length,
          citedAssetVersionIds: report.citedAssetVersionIds,
          retrievedNotCitedAssetVersionIds: report.retrievedNotCitedAssetVersionIds,
        });
      }

      case 'prepare_sale': {
        const artifactId = asString(args, 'artifactId');
        const artifact = await ctx.db.artifact.findUnique({ where: { id: artifactId }, include: { buildJob: { select: { agentRunId: true } } } });
        if (!artifact || artifact.buildJob.agentRunId !== ctx.runId) return ok({ error: 'NOT_FOUND', message: 'Unknown artifact for this run.' });
        return ok({ artifactId, listed: artifact.status === 'listed', priceCents: artifact.priceCents, currency: artifact.currency, checkout: 'PayPal (sandbox)' });
      }

      default:
        return ok({ error: 'UNKNOWN_TOOL', message: `No tool named "${name}".` });
    }
  } catch (err) {
    if (err instanceof ToolInputError) return ok({ error: 'BAD_INPUT', message: err.message });
    return ok({ error: 'TOOL_FAILED', message: (err as Error).message });
  }
}
