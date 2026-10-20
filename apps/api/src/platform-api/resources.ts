import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import { PURPOSES, type BuildIntent, type LicenseTerms, type PreflightReport } from '@tracepay/shared';
import type { ArtifactContent } from '../modules/generation/generation.service';
import type { CatalogEntry } from '../modules/catalog/catalog.service';
import type { DeliveryRow, EndpointRow } from '../modules/platform/webhooks';
import { listOf, named } from './framework';

/**
 * Public resource shapes of the platform API: snake_case, an `object` type tag,
 * ISO-8601 timestamps, money as integer cents. Serializers pick fields
 * explicitly — internal columns (payout addresses of other parties, raw PayPal
 * payloads, source text) never leak by accident.
 */

const ts = z.iso.datetime({ offset: true });
const id = z.string();
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---- license terms & intent --------------------------------------------------------------

export const Economics = named(
  'Economics',
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('percent_of_gross'), bps: z.number().int().min(0).max(10_000).meta({ description: 'Basis points of the gross sale (100 bps = 1%).' }) }),
    z.object({ kind: z.literal('fixed_per_sale'), amount_cents: z.number().int().min(0) }),
    z.object({ kind: z.literal('none') }),
  ]),
  'What the contributor is owed per sale.',
);

export const LicenseTermsOut = named(
  'LicenseTerms',
  z.object({
    commercial_use: z.boolean(),
    derivative_reports: z.enum(['allowed', 'allowed_with_attribution', 'prohibited']),
    raw_redistribution: z.boolean(),
    allowed_purposes: z.array(z.enum(PURPOSES)),
    territories: z.array(z.string()).nullable().meta({ description: 'ISO-3166 alpha-2 codes; null = worldwide.' }),
    valid_from: z.iso.date(),
    valid_until: z.iso.date().nullable(),
    attribution_text: z.string().nullable(),
    economics: Economics,
    payable_on: z.enum(['included_in_build', 'cited_in_output']),
    currency: z.literal('USD'),
  }),
  'Normalized, machine-enforced license terms. Only terms both parties agreed to are ever enforced.',
);

export function termsOut(t: LicenseTerms): z.infer<typeof LicenseTermsOut> {
  const e = t.economics;
  return {
    commercial_use: t.commercialUse,
    derivative_reports: t.derivativeReports,
    raw_redistribution: t.rawRedistribution,
    allowed_purposes: [...t.allowedPurposes],
    territories: t.territories,
    valid_from: t.validFrom,
    valid_until: t.validUntil,
    attribution_text: t.attributionText,
    economics: e.kind === 'percent_of_gross' ? { kind: e.kind, bps: e.bps } : e.kind === 'fixed_per_sale' ? { kind: e.kind, amount_cents: e.amountCents } : { kind: 'none' },
    payable_on: t.payableOn,
    currency: t.currency,
  };
}

export const IntentIn = named(
  'BuildIntent',
  z.object({
    title: z.string().min(3).max(200),
    brief: z.string().min(10).max(4000),
    purpose: z.enum(PURPOSES),
    distribution: z.enum(['sale', 'internal']).meta({ description: '`sale` lists the report in the store; `internal` keeps it in-house.' }),
    includes_raw_data: z.boolean().meta({ description: 'Would the report expose raw source content (e.g. a data appendix)?' }),
    territory: z.string().regex(/^[A-Za-z]{2}$/).meta({ description: 'ISO-3166 alpha-2 country where it will be sold or used.' }),
    price_cents: z.number().int().min(0).max(1_000_000),
    currency: z.literal('USD'),
  }),
  'What you want to produce. The license compiler checks it against every source’s terms.',
);

export function intentIn(i: z.infer<typeof IntentIn>): BuildIntent {
  return {
    title: i.title,
    brief: i.brief,
    purpose: i.purpose,
    distribution: i.distribution,
    includesRawData: i.includes_raw_data,
    territory: i.territory.toUpperCase(),
    priceCents: i.price_cents,
    currency: i.currency,
  };
}

function intentOut(i: BuildIntent): z.infer<typeof IntentIn> {
  return {
    title: i.title,
    brief: i.brief,
    purpose: i.purpose,
    distribution: i.distribution,
    includes_raw_data: i.includesRawData,
    territory: i.territory,
    price_cents: i.priceCents,
    currency: i.currency,
  };
}

// ---- account ----------------------------------------------------------------------------------

export const Account = named(
  'Account',
  z.object({
    id,
    object: z.literal('account'),
    name: z.string(),
    email: z.string(),
    role: z.enum(['publisher', 'contributor', 'buyer', 'admin']),
    authenticated_with: z.enum(['api_key', 'session', 'demo']),
    api_key: z.object({ id, access: z.enum(['read_only', 'read_write']) }).nullable(),
  }),
);

// ---- sources ----------------------------------------------------------------------------------

export const Source = named(
  'Source',
  z.object({
    id,
    object: z.literal('source'),
    title: z.string(),
    kind: z.string(),
    description: z.string(),
    owner: z.object({ id, name: z.string() }),
    version: z.object({ id: id.meta({ description: 'Pin this id in `source_version_ids` when creating a build.' }), number: z.number().int(), sha256: z.string(), passages: z.number().int() }),
    license: z
      .object({ id, version: z.number().int(), status: z.enum(['approved', 'revoked']), terms: LicenseTermsOut, terms_hash: z.string() })
      .nullable()
      .meta({ description: 'The license in force for you (or the revoked one that blocks use). Null if you hold none.' }),
    pending_license: z
      .object({ id, version: z.number().int(), status: z.enum(['requested', 'offered']), terms: LicenseTermsOut.nullable() })
      .nullable()
      .meta({ description: 'A request or offer awaiting a decision.' }),
  }),
  'A licensable source (dataset, research notes, …) and your license status for it.',
);
export const SourceList = listOf('Source', Source);

export function sourceOut(e: CatalogEntry): z.infer<typeof Source> {
  return {
    id: e.assetId,
    object: 'source',
    title: e.assetTitle,
    kind: e.kind,
    description: e.description,
    owner: { id: e.owner.id, name: e.owner.name },
    version: { id: e.assetVersionId, number: e.version, sha256: e.sha256, passages: e.chunkCount },
    license: e.license ? { id: e.license.id, version: e.license.version, status: e.license.status as 'approved' | 'revoked', terms: termsOut(e.license.terms), terms_hash: e.license.termsHash } : null,
    pending_license: e.pending
      ? { id: e.pending.id, version: e.pending.version, status: e.pending.status as 'requested' | 'offered', terms: e.pending.terms ? termsOut(e.pending.terms) : null }
      : null,
  };
}

// ---- licenses ---------------------------------------------------------------------------------

export const License = named(
  'License',
  z.object({
    id,
    object: z.literal('license'),
    source: z.object({ id, title: z.string(), owner_name: z.string() }),
    version: z.number().int(),
    status: z.enum(['requested', 'draft', 'offered', 'approved', 'declined', 'withdrawn', 'revoked', 'superseded']),
    terms: LicenseTermsOut.nullable(),
    terms_hash: z.string().nullable().meta({ description: 'Send this back when accepting, to bind exactly the terms you reviewed.' }),
    origin: z.enum(['manual', 'ai_draft', 'rules_draft']),
    request_message: z.string().nullable(),
    offered_at: ts.nullable(),
    approved_at: ts.nullable(),
    closed_at: ts.nullable(),
    closed_reason: z.string().nullable(),
    created: ts,
    updated: ts,
  }),
  'A license between a contributor’s source and your account, at one version of its terms.',
);
export const LicenseList = listOf('License', License);

export interface LicenseRow {
  id: string;
  version: number;
  status: string;
  terms: unknown;
  termsHash: string | null;
  origin: string;
  requestMessage: string | null;
  offeredAt: Date | null;
  approvedAt: Date | null;
  closedAt: Date | null;
  closedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  asset: { id: string; title: string; owner: { name: string } };
}

export function licenseOut(g: LicenseRow, parseTerms: (t: unknown) => LicenseTerms | null): z.infer<typeof License> {
  const terms = g.terms ? parseTerms(g.terms) : null;
  return {
    id: g.id,
    object: 'license',
    source: { id: g.asset.id, title: g.asset.title, owner_name: g.asset.owner.name },
    version: g.version,
    status: g.status as z.infer<typeof License>['status'],
    terms: terms ? termsOut(terms) : null,
    terms_hash: g.termsHash,
    origin: g.origin as z.infer<typeof License>['origin'],
    request_message: g.requestMessage,
    offered_at: iso(g.offeredAt),
    approved_at: iso(g.approvedAt),
    closed_at: iso(g.closedAt),
    closed_reason: g.closedReason,
    created: g.createdAt.toISOString(),
    updated: g.updatedAt.toISOString(),
  };
}

// ---- builds -----------------------------------------------------------------------------------

const RuleResult = z.object({
  rule_id: z.string(),
  source_version_id: z.string().nullable(),
  outcome: z.enum(['pass', 'fail', 'skip', 'obligation']),
  message: z.string(),
});

export const Build = named(
  'Build',
  z.object({
    id,
    object: z.literal('build'),
    status: z.enum(['preflight_blocked', 'preflight_passed', 'generating', 'generated', 'generation_failed']),
    intent: IntentIn,
    as_of: z.iso.date().meta({ description: 'The date license validity was evaluated for.' }),
    preflight: z.object({
      verdict: z.enum(['pass', 'block']),
      policy_version: z.string(),
      rules: z.array(RuleResult),
      attribution_obligations: z.array(z.object({ source_version_id: z.string(), source_title: z.string(), text: z.string() })),
      economics: z.object({
        price_cents: z.number().int(),
        total_bps: z.number().int(),
        fixed_fees_cents: z.number().int(),
        max_contributor_cents: z.number().int(),
        min_publisher_residual_cents: z.number().int(),
      }),
    }),
    snapshot_hash: z.string().meta({ description: 'Hash of the license terms frozen onto this build.' }),
    sources: z.array(
      z.object({ position: z.number().int(), source_id: z.string(), source_version_id: z.string(), title: z.string(), version: z.number().int(), sha256: z.string(), license_id: z.string().nullable() }),
    ),
    report_id: z.string().nullable(),
    agent_run_id: z.string().nullable(),
    created: ts,
  }),
  'A license-checked plan for one report. A blocked build is recorded too, with the rules that blocked it.',
);
export const BuildList = listOf('Build', Build);

export interface BuildRow {
  id: string;
  status: string;
  intent: unknown;
  asOf: string;
  preflight: unknown;
  policyVersion: string;
  snapshotHash: string;
  agentRunId: string | null;
  createdAt: Date;
  artifact: { id: string } | null;
  sources: { ordinal: number; assetVersionId: string; licenseGrantId: string | null; assetVersion: { version: number; sha256: string; asset: { id: string; title: string } } }[];
}

export const buildSelect = {
  id: true, status: true, intent: true, asOf: true, preflight: true, policyVersion: true, snapshotHash: true, agentRunId: true, createdAt: true,
  artifact: { select: { id: true } },
  sources: {
    orderBy: { ordinal: 'asc' as const },
    select: { ordinal: true, assetVersionId: true, licenseGrantId: true, assetVersion: { select: { version: true, sha256: true, asset: { select: { id: true, title: true } } } } },
  },
} as const;

export function buildOut(b: BuildRow): z.infer<typeof Build> {
  const p = b.preflight as PreflightReport;
  return {
    id: b.id,
    object: 'build',
    status: b.status as z.infer<typeof Build>['status'],
    intent: intentOut(b.intent as BuildIntent),
    as_of: b.asOf,
    preflight: {
      verdict: p.verdict,
      policy_version: p.policyVersion,
      rules: p.results.map((r) => ({ rule_id: r.ruleId, source_version_id: r.assetVersionId ?? null, outcome: r.outcome, message: r.message })),
      attribution_obligations: p.obligations.map((o) => ({ source_version_id: o.assetVersionId, source_title: o.assetTitle, text: o.text })),
      economics: {
        price_cents: p.economics.priceCents,
        total_bps: p.economics.totalBps,
        fixed_fees_cents: p.economics.fixedFeesCents,
        max_contributor_cents: p.economics.maxContributorCents,
        min_publisher_residual_cents: p.economics.minPublisherResidualCents,
      },
    },
    snapshot_hash: b.snapshotHash,
    sources: b.sources.map((s) => ({
      position: s.ordinal,
      source_id: s.assetVersion.asset.id,
      source_version_id: s.assetVersionId,
      title: s.assetVersion.asset.title,
      version: s.assetVersion.version,
      sha256: s.assetVersion.sha256,
      license_id: s.licenseGrantId,
    })),
    report_id: b.artifact?.id ?? null,
    agent_run_id: b.agentRunId,
    created: b.createdAt.toISOString(),
  };
}

// ---- reports ----------------------------------------------------------------------------------

const ReportSection = z.object({ key: z.string(), heading: z.string(), body: z.string() });

export const Report = named(
  'Report',
  z.object({
    id,
    object: z.literal('report'),
    title: z.string(),
    status: z.enum(['draft', 'listed', 'withdrawn']).meta({ description: '`listed` = on sale; `withdrawn` = taken off sale; `draft` = internal only.' }),
    summary: z.string().nullable(),
    price_cents: z.number().int(),
    currency: z.string(),
    content_hash: z.string(),
    model: z.string(),
    from_fixture: z.boolean().meta({ description: 'True when written by the labeled demo writer instead of Gemini.' }),
    build_id: z.string(),
    sources: z.array(z.object({ source_version_id: z.string(), title: z.string(), version: z.number().int(), sha256: z.string(), cited: z.boolean() })),
    credits: z.array(z.string()),
    withdrawn_reason: z.string().nullable(),
    content: z
      .object({ sections: z.array(ReportSection) })
      .nullable()
      .meta({ description: 'The full report, only when requested with `?include=content`.' }),
    created: ts,
  }),
  'A generated, citation-checked report.',
);
export const ReportList = listOf('Report', Report);

export interface ArtifactRow {
  id: string;
  title: string;
  status: string;
  priceCents: number;
  currency: string;
  contentHash: string;
  model: string;
  fromFixture: boolean;
  buildJobId: string;
  content: unknown;
  createdAt: Date;
}

export function reportOut(a: ArtifactRow, opts: { withdrawnReason?: string | null; includeContent?: boolean } = {}): z.infer<typeof Report> {
  const c = a.content as ArtifactContent;
  return {
    id: a.id,
    object: 'report',
    title: a.title,
    status: a.status as z.infer<typeof Report>['status'],
    summary: c.sections.find((s) => s.key === 'summary')?.body ?? null,
    price_cents: a.priceCents,
    currency: a.currency,
    content_hash: a.contentHash,
    model: a.model,
    from_fixture: a.fromFixture,
    build_id: a.buildJobId,
    sources: c.sources.map((s) => ({ source_version_id: s.assetVersionId, title: s.assetTitle, version: s.version, sha256: s.sha256, cited: s.cited })),
    credits: c.credits.map((cr) => cr.text),
    withdrawn_reason: a.status === 'withdrawn' ? (opts.withdrawnReason ?? null) : null,
    content: opts.includeContent ? { sections: c.sections.map((s) => ({ key: s.key, heading: s.heading, body: s.body })) } : null,
    created: a.createdAt.toISOString(),
  };
}

export const Generation = named(
  'Generation',
  z.object({
    object: z.literal('generation'),
    build_id: z.string(),
    report: Report,
    attempts: z.number().int(),
    model: z.string(),
    from_fixture: z.boolean(),
  }),
  'The outcome of generating a report from a passed build.',
);

// ---- sales ------------------------------------------------------------------------------------

export const Sale = named(
  'Sale',
  z.object({
    id,
    object: z.literal('sale'),
    report: z.object({ id, title: z.string() }),
    status: z.enum(['pending_payment', 'captured', 'payment_failed', 'refunded', 'exception']),
    amount_cents: z.number().int(),
    currency: z.string(),
    paypal: z
      .object({ order_id: z.string(), capture_id: z.string().nullable(), capture_status: z.string().nullable(), captured_cents: z.number().int().nullable() })
      .nullable(),
    settlement_id: z.string().nullable(),
    created: ts,
  }),
  'A purchase of one of your reports, paid with PayPal.',
);
export const SaleList = listOf('Sale', Sale);

export const saleSelect = {
  id: true, status: true, amountCents: true, currency: true, createdAt: true,
  artifact: { select: { id: true, title: true } },
  payment: { select: { orderId: true, captureId: true, captureStatus: true, capturedCents: true } },
  settlement: { select: { id: true } },
} as const;

export function saleOut(s: {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  createdAt: Date;
  artifact: { id: string; title: string };
  payment: { orderId: string; captureId: string | null; captureStatus: string | null; capturedCents: number | null } | null;
  settlement: { id: string } | null;
}): z.infer<typeof Sale> {
  return {
    id: s.id,
    object: 'sale',
    report: { id: s.artifact.id, title: s.artifact.title },
    status: s.status as z.infer<typeof Sale>['status'],
    amount_cents: s.amountCents,
    currency: s.currency,
    paypal: s.payment
      ? { order_id: s.payment.orderId, capture_id: s.payment.captureId, capture_status: s.payment.captureStatus, captured_cents: s.payment.capturedCents }
      : null,
    settlement_id: s.settlement?.id ?? null,
    created: s.createdAt.toISOString(),
  };
}

// ---- settlements ------------------------------------------------------------------------------

export const Settlement = named(
  'Settlement',
  z.object({
    id,
    object: z.literal('settlement'),
    sale_id: z.string(),
    report_id: z.string(),
    status: z.enum(['calculated', 'approved', 'payout_submitted', 'completed', 'exception']),
    gross_cents: z.number().int(),
    contributor_total_cents: z.number().int(),
    publisher_residual_cents: z.number().int(),
    rounding_rule: z.string(),
    approved_at: ts.nullable(),
    failure_reason: z.string().nullable(),
    lines: z.array(
      z.object({
        id,
        kind: z.enum(['contributor', 'publisher_residual']),
        recipient: z.object({ id, name: z.string() }),
        payee_email: z.string().nullable().meta({ description: 'Where the payout goes. Visible only to the settlement’s publisher.' }),
        source_version_id: z.string().nullable(),
        license_id: z.string().nullable(),
        amount_cents: z.number().int(),
        formula: z.string(),
        payable: z.boolean(),
        note: z.string().nullable(),
        payout: z.object({ status: z.string(), paypal_item_id: z.string().nullable(), transaction_id: z.string().nullable(), error: z.string().nullable() }).nullable(),
      }),
    ),
    payout_batches: z.array(
      z.object({ id, attempt: z.number().int(), sender_batch_id: z.string(), paypal_batch_id: z.string().nullable(), status: z.string(), last_checked_at: ts.nullable(), created: ts }),
    ),
    created: ts,
  }),
  'The revenue split of one sale, frozen from the license terms in force when it was sold, and its PayPal payouts.',
);
export const SettlementList = listOf('Settlement', Settlement);

export const settlementInclude = {
  lines: { include: { payoutItem: true }, orderBy: [{ amountCents: 'desc' }, { id: 'asc' }] },
  batches: { orderBy: { attempt: 'desc' } },
  sale: { select: { artifactId: true } },
} satisfies Prisma.SettlementRunInclude;

export function settlementOut(
  r: {
    id: string;
    saleId: string;
    status: string;
    grossCents: number;
    contributorTotalCents: number;
    publisherResidualCents: number;
    roundingRule: string;
    approvedAt: Date | null;
    failureReason: string | null;
    createdAt: Date;
    sale: { artifactId: string };
    lines: {
      id: string;
      kind: string;
      recipientId: string;
      payeeEmail: string | null;
      assetVersionId: string | null;
      licenseGrantId: string | null;
      amountCents: number;
      formula: string;
      payable: boolean;
      note: string | null;
      payoutItem: { status: string; paypalItemId: string | null; transactionId: string | null; errorName: string | null } | null;
    }[];
    batches: { id: string; attempt: number; senderBatchId: string; paypalBatchId: string | null; status: string; lastCheckedAt: Date | null; createdAt: Date }[];
  },
  names: Map<string, string>,
): z.infer<typeof Settlement> {
  return {
    id: r.id,
    object: 'settlement',
    sale_id: r.saleId,
    report_id: r.sale.artifactId,
    status: r.status as z.infer<typeof Settlement>['status'],
    gross_cents: r.grossCents,
    contributor_total_cents: r.contributorTotalCents,
    publisher_residual_cents: r.publisherResidualCents,
    rounding_rule: r.roundingRule,
    approved_at: iso(r.approvedAt),
    failure_reason: r.failureReason,
    lines: r.lines.map((l) => ({
      id: l.id,
      kind: l.kind as 'contributor' | 'publisher_residual',
      recipient: { id: l.recipientId, name: names.get(l.recipientId) ?? 'Unknown' },
      payee_email: l.payeeEmail,
      source_version_id: l.assetVersionId,
      license_id: l.licenseGrantId,
      amount_cents: l.amountCents,
      formula: l.formula,
      payable: l.payable,
      note: l.note,
      payout: l.payoutItem
        ? { status: l.payoutItem.status, paypal_item_id: l.payoutItem.paypalItemId, transaction_id: l.payoutItem.transactionId, error: l.payoutItem.errorName }
        : null,
    })),
    payout_batches: r.batches.map((b) => ({
      id: b.id,
      attempt: b.attempt,
      sender_batch_id: b.senderBatchId,
      paypal_batch_id: b.paypalBatchId,
      status: b.status,
      last_checked_at: iso(b.lastCheckedAt),
      created: b.createdAt.toISOString(),
    })),
    created: r.createdAt.toISOString(),
  };
}

// ---- agent runs -------------------------------------------------------------------------------

export const AgentRun = named(
  'AgentRun',
  z.object({
    id,
    object: z.literal('agent_run'),
    goal: z.string(),
    status: z.enum(['running', 'awaiting_approval', 'completed', 'failed']),
    planner: z.string().nullable(),
    auto_replace: z.boolean(),
    pending_approval: z.unknown().nullable().meta({ description: 'What the agent proposes and waits for you to approve or decline.' }),
    summary: z.string().nullable(),
    builds: z.array(z.object({ id, status: z.string(), report_id: z.string().nullable() })),
    created: ts,
    finished_at: ts.nullable(),
  }),
  'A bounded Publisher Agent run: it plans a report, checks licenses, proposes replacements and asks before risky steps.',
);
export const AgentRunList = listOf('AgentRun', AgentRun);

export const agentRunSelect = {
  id: true, goal: true, status: true, model: true, policy: true, pending: true, summary: true, createdAt: true, finishedAt: true,
  builds: { orderBy: { createdAt: 'asc' as const }, select: { id: true, status: true, artifact: { select: { id: true } } } },
} as const;

export function agentRunOut(r: {
  id: string;
  goal: string;
  status: string;
  model: string | null;
  policy: unknown;
  pending: unknown;
  summary: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  builds: { id: string; status: string; artifact: { id: string } | null }[];
}): z.infer<typeof AgentRun> {
  return {
    id: r.id,
    object: 'agent_run',
    goal: r.goal,
    status: r.status as z.infer<typeof AgentRun>['status'],
    planner: r.model,
    auto_replace: Boolean((r.policy as { autoReplace?: boolean } | null)?.autoReplace),
    pending_approval: r.pending ?? null,
    summary: r.summary,
    builds: r.builds.map((b) => ({ id: b.id, status: b.status, report_id: b.artifact?.id ?? null })),
    created: r.createdAt.toISOString(),
    finished_at: iso(r.finishedAt),
  };
}

// ---- receipts & provenance -----------------------------------------------------------------------

export const Receipt = named(
  'Receipt',
  z.object({
    object: z.literal('receipt'),
    algorithm: z.literal('Ed25519'),
    document: z.record(z.string(), z.unknown()).meta({ description: 'The signed document: report, sources, rights check, PayPal references, settlement, payouts and audit trail.' }),
    signature: z.string().meta({ description: 'Base64 Ed25519 signature over the canonical JSON of `document`.' }),
    public_key_pem: z.string(),
  }),
  'A signed audit receipt, verifiable offline with TracePay’s public key.',
);

export const Provenance = named(
  'Provenance',
  z.object({
    object: z.literal('provenance'),
    report_id: z.string(),
    nodes: z.array(z.record(z.string(), z.unknown())),
    edges: z.array(z.record(z.string(), z.unknown())),
  }),
  'The provenance graph: sources → passages → report sections → sale → settlement lines → payouts, each tagged with its evidence class.',
);

// ---- events & webhooks ------------------------------------------------------------------------

export const Event = named(
  'Event',
  z.object({
    id: z.string().meta({ description: 'Stable across retries: use it to de-duplicate.' }),
    object: z.literal('event'),
    type: z.string(),
    api_version: z.literal('v1'),
    created: ts,
    sandbox: z.boolean(),
    data: z.record(z.string(), z.unknown()).meta({ description: 'Thin payload: `object_type`, `object_id` and a few fields. Fetch the object for everything else.' }),
  }),
  'Something that happened in your account. Also the body of every webhook delivery.',
);
export const EventList = listOf('Event', Event);

export const EventType = named('EventType', z.object({ type: z.string(), description: z.string() }));
export const EventTypeList = named('EventTypeList', z.object({ object: z.literal('list'), data: z.array(EventType), has_more: z.literal(false), next_cursor: z.null() }));

export const WebhookEndpoint = named(
  'WebhookEndpoint',
  z.object({
    id,
    object: z.literal('webhook_endpoint'),
    url: z.string(),
    description: z.string().nullable(),
    enabled_events: z.array(z.string()).meta({ description: 'Event types sent to this endpoint; `["*"]` = all.' }),
    status: z.enum(['enabled', 'disabled']),
    disabled_reason: z.string().nullable(),
    consecutive_failures: z.number().int(),
    failing_since: ts.nullable(),
    previous_secret_expires_at: ts.nullable().meta({ description: 'After a rotation, deliveries are signed with both secrets until this time.' }),
    created: ts,
    updated: ts,
  }),
  'A URL that receives signed event notifications.',
);
export const WebhookEndpointList = listOf('WebhookEndpoint', WebhookEndpoint);
export const WebhookEndpointWithSecret = named(
  'WebhookEndpointWithSecret',
  WebhookEndpoint.extend({
    secret: z
      .string()
      .nullable()
      .meta({ description: 'The signing secret (`whsec_…`). Shown only in this response: store it securely. `null` when the response is an Idempotency-Key replay — secrets are never stored; rotate to get a new one.' }),
  }),
);

export function endpointOut(e: EndpointRow): z.infer<typeof WebhookEndpoint> {
  return {
    id: e.id,
    object: 'webhook_endpoint',
    url: e.url,
    description: e.description,
    enabled_events: e.enabledEvents,
    status: e.status,
    disabled_reason: e.disabledReason,
    consecutive_failures: e.consecutiveFailures,
    failing_since: iso(e.failingSince),
    previous_secret_expires_at: e.previousSecretExpires && e.previousSecretExpires > new Date() ? e.previousSecretExpires.toISOString() : null,
    created: e.createdAt.toISOString(),
    updated: e.updatedAt.toISOString(),
  };
}

export const WebhookDelivery = named(
  'WebhookDelivery',
  z.object({
    id,
    object: z.literal('webhook_delivery'),
    event_id: z.string(),
    event_type: z.string(),
    endpoint_id: z.string(),
    status: z.enum(['pending', 'succeeded', 'failed', 'skipped']),
    attempts: z.number().int(),
    next_attempt_at: ts.nullable(),
    last_attempt_at: ts.nullable(),
    last_status_code: z.number().int().nullable(),
    last_error: z.string().nullable(),
    history: z.array(z.object({ at: ts, attempt: z.number().int(), status_code: z.number().int().nullable(), error: z.string().nullable(), duration_ms: z.number().int() })),
    created: ts,
  }),
  'One event sent (or being sent) to one endpoint, with every attempt.',
);
export const WebhookDeliveryList = listOf('WebhookDelivery', WebhookDelivery);

export function deliveryOut(d: DeliveryRow): z.infer<typeof WebhookDelivery> {
  return {
    id: d.id,
    object: 'webhook_delivery',
    event_id: d.eventId,
    event_type: d.event.type,
    endpoint_id: d.endpointId,
    status: d.status,
    attempts: d.attempts,
    next_attempt_at: iso(d.nextAttemptAt),
    last_attempt_at: iso(d.lastAttemptAt),
    last_status_code: d.lastStatusCode,
    last_error: d.lastError,
    history: ((d.history as unknown[]) ?? []) as z.infer<typeof WebhookDelivery>['history'],
    created: d.createdAt.toISOString(),
  };
}

export const Deleted = named('Deleted', z.object({ id, object: z.string(), deleted: z.literal(true) }));
