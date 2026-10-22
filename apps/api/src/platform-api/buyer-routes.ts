import { z } from 'zod';
import type { AppDeps } from '../app';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';
import { matchScore } from '../modules/agent/buyer-tools';
import type { CitationReport } from '../modules/generation/citations';
import type { ArtifactContent } from '../modules/generation/generation.service';
import { captureSale, startCheckout } from '../modules/payments/payments.service';
import { askLibrary, getAnswer, listAnswers, listLibraries } from '../modules/answers/answers.service';
import { captureTopUp, creditSummary, MAX_TOP_UP_CENTS, startTopUp } from '../modules/answers/credits.service';
import { checkSaleRights } from '../modules/sales/rights.service';
import { defineRoute, listOf, named, type AnyRoute } from './framework';

/**
 * Buying through the API — for a buyer's own software or AI agent (see the MCP
 * server in packages/mcp). An agent can search, check and start a checkout; the
 * payment itself always needs the buyer: they approve it at PayPal's approve_url.
 */

const id = z.string();
const ts = z.iso.datetime({ offset: true });
const Id = z.object({ id: z.string().min(1).max(64).meta({ description: 'The id.' }) });
const TAG = 'Buying';

export const StoreReport = named(
  'StoreReport',
  z.object({
    id,
    object: z.literal('store_report'),
    title: z.string(),
    summary: z.string().nullable(),
    price_cents: z.number().int(),
    currency: z.string(),
    section_headings: z.array(z.string()),
    sources: z.array(z.object({ title: z.string(), cited: z.boolean() })),
    citations_ok: z.boolean().meta({ description: 'Every citation in the report resolves to a passage retrieved from a licensed source.' }),
    written_by: z.object({ model: z.string(), ai: z.boolean() }),
    owned: z.boolean().meta({ description: 'You have already bought it.' }),
    match: z.number().nullable().meta({ description: 'How well it matches the search query, 0–1 (null without a query).' }),
    created: ts,
  }),
  'A report for sale, as a buyer sees it before paying.',
);
const StoreReportList = listOf('StoreReport', StoreReport);

export const StoreReportDetail = named(
  'StoreReportDetail',
  StoreReport.extend({
    license_check: z
      .object({ valid_today: z.boolean(), problems: z.array(z.string()) })
      .meta({ description: 'The license compiler re-run on the report’s sources with the licenses in force today. A sale is only possible when valid.' }),
    content: z
      .array(z.object({ heading: z.string(), body: z.string() }))
      .nullable()
      .meta({ description: 'The full report — only once you own it.' }),
  }),
  'A report for sale with a fresh license check, and its content if you own it.',
);

export const Checkout = named(
  'Checkout',
  z.object({
    id,
    object: z.literal('checkout'),
    report_id: id,
    status: z.enum(['pending_payment', 'captured', 'payment_failed', 'refunded', 'exception']),
    amount_cents: z.number().int(),
    currency: z.string(),
    paypal_order_id: z.string().nullable(),
    approve_url: z.string().nullable().meta({ description: 'Where the buyer approves the payment at PayPal. Only the buyer can do this — not an agent.' }),
    capture_id: z.string().nullable(),
    next_step: z.string().meta({ description: 'What happens next, in plain words.' }),
    created: ts,
  }),
  'One purchase attempt: a PayPal order the buyer approves, which TracePay then captures and verifies.',
);

type Artifact = { id: string; title: string; priceCents: number; currency: string; model: string; fromFixture: boolean; createdAt: Date; content: unknown; citationReport: unknown };

function storeReportOut(a: Artifact, owned: boolean, match: number | null): z.infer<typeof StoreReport> {
  const c = a.content as ArtifactContent;
  return {
    id: a.id,
    object: 'store_report',
    title: a.title,
    summary: c.sections.find((s) => s.key === 'summary')?.body ?? null,
    price_cents: a.priceCents,
    currency: a.currency,
    section_headings: c.sections.map((s) => s.heading),
    sources: c.sources.map((s) => ({ title: s.assetTitle, cited: s.cited })),
    citations_ok: Boolean((a.citationReport as CitationReport | null)?.ok),
    written_by: { model: a.model, ai: !a.fromFixture },
    owned,
    match,
    created: a.createdAt.toISOString(),
  };
}

const sandboxApproveUrl = (orderId: string) => `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(orderId)}`;

type SaleRow = { id: string; artifactId: string; status: string; amountCents: number; currency: string; createdAt: Date; payment: { orderId: string; captureId: string | null } | null };

function checkoutOut(s: SaleRow): z.infer<typeof Checkout> {
  const status = s.status as z.infer<typeof Checkout>['status'];
  const pendingCapture = status === 'pending_payment' && s.payment?.captureId;
  const next_step = {
    pending_payment: pendingCapture
      ? 'PayPal is still processing the payment. Check again later.'
      : 'Ask the buyer to approve the payment at approve_url, then call POST /checkouts/{id}/capture.',
    captured: 'Paid and verified. The report is unlocked: GET /store/reports/{report_id}.',
    payment_failed: 'This checkout is closed and nothing was charged. Start a new one if the buyer still wants the report.',
    refunded: 'The payment was refunded.',
    exception: 'TracePay is double-checking this payment with PayPal.',
  }[status];
  return {
    id: s.id,
    object: 'checkout',
    report_id: s.artifactId,
    status,
    amount_cents: s.amountCents,
    currency: s.currency,
    paypal_order_id: s.payment?.orderId ?? null,
    approve_url: status === 'pending_payment' && s.payment && !pendingCapture ? sandboxApproveUrl(s.payment.orderId) : null,
    capture_id: s.payment?.captureId ?? null,
    next_step,
    created: s.createdAt.toISOString(),
  };
}

const saleSelect = { id: true, artifactId: true, status: true, amountCents: true, currency: true, createdAt: true, payment: { select: { orderId: true, captureId: true } } } as const;

// ---- pay-per-citation answers ---------------------------------------------------------

export const Library = named('Library', z.object({ id, object: z.literal('library'), name: z.string(), sources_licensed_for_ai: z.number().int() }), 'A publisher’s licensed library that answers questions.');
const LibraryList = listOf('Library', Library);

export const CreditBalance = named(
  'CreditBalance',
  z.object({
    object: z.literal('credit_balance'),
    balance_cents: z.number().int(),
    reserved_cents: z.number().int().meta({ description: 'Held for answers in progress (their worst-case price).' }),
    available_cents: z.number().int(),
    entries: z.array(z.object({ id, kind: z.string(), amount_cents: z.number().int(), answer_id: z.string().nullable(), top_up_id: z.string().nullable(), created: ts })),
  }),
  'Prepaid answer credit, topped up with PayPal. Entries always sum to the balance.',
);

export const CreditTopUp = named(
  'CreditTopUp',
  z.object({
    id,
    object: z.literal('credit_top_up'),
    status: z.string(),
    amount_cents: z.number().int(),
    paypal_order_id: z.string().nullable(),
    approve_url: z.string().nullable().meta({ description: 'Where the buyer approves the payment at PayPal — software can’t.' }),
    capture_id: z.string().nullable(),
  }),
  'Buying answer credit with PayPal.',
);

export const AnswerResource = named(
  'Answer',
  z.object({
    id,
    object: z.literal('answer'),
    status: z.enum(['answering', 'answered', 'not_covered', 'failed']),
    question: z.string(),
    library: z.object({ id, name: z.string() }),
    text: z.string().nullable().meta({ description: 'The answer, with [C1]… markers for its citations.' }),
    model: z.string().nullable(),
    from_fixture: z.boolean(),
    citations: z.array(z.object({ handle: z.string(), source_title: z.string().nullable(), paid: z.boolean() })),
    paid: z
      .array(z.object({ source_title: z.string(), contributor: z.string(), citations: z.number().int(), cents_per_citation: z.number().int(), amount_cents: z.number().int() }))
      .meta({ description: 'Who was paid for this answer: only passages it verifiably relied on.' }),
    not_paid: z.object({ unsupported: z.number().int(), repeated: z.number().int(), over_cap: z.number().int() }).meta({ description: 'Citations that earned nothing, and why.' }),
    excluded: z.array(z.object({ source_title: z.string(), contributor: z.string(), code: z.string(), reason: z.string() })).meta({ description: 'Sources left out (license, price limit).' }),
    fee_cents: z.number().int(),
    charged_cents: z.number().int(),
    max_price_cents: z.number().int(),
    failure_reason: z.string().nullable(),
    receipt: z.object({ document: z.record(z.string(), z.unknown()), signature: z.string(), algorithm: z.literal('Ed25519'), public_key_pem: z.string() }).nullable(),
    created: ts,
  }),
  'A question answered from licensed sources, paid per verified citation, with a signed receipt.',
);
const AnswerSummaryList = listOf(
  'AnswerSummary',
  named('AnswerSummary', z.object({ id, object: z.literal('answer'), question: z.string(), status: z.string(), library_name: z.string(), charged_cents: z.number().int(), created: ts })),
);

type AnswerView = Awaited<ReturnType<typeof getAnswer>>;
function answerOutV1(a: AnswerView): z.infer<typeof AnswerResource> {
  return {
    id: a.id,
    object: 'answer',
    status: a.status,
    question: a.question,
    library: a.library,
    text: a.text,
    model: a.model,
    from_fixture: a.fromFixture,
    citations: a.citations.map((c) => ({ handle: c.handle, source_title: c.title, paid: c.paid })),
    paid: a.paid.map((p) => ({ source_title: p.title, contributor: p.contributor, citations: p.citations, cents_per_citation: p.centsPerCitation, amount_cents: p.amountCents })),
    not_paid: { unsupported: a.notPaid.unsupported, repeated: a.notPaid.repeated, over_cap: a.notPaid.overCap },
    excluded: a.excluded.map((e) => ({ source_title: e.title, contributor: e.contributor, code: e.code, reason: e.reason })),
    fee_cents: a.feeCents,
    charged_cents: a.chargedCents,
    max_price_cents: a.maxPriceCents,
    failure_reason: a.failureReason,
    receipt: a.receipt ? { document: a.receipt.document as Record<string, unknown>, signature: a.receipt.signature, algorithm: 'Ed25519', public_key_pem: a.receipt.publicKeyPem } : null,
    created: a.createdAt.toISOString(),
  };
}

export function buyerRoutes({ db, paypal, config, answerWriter, signingKeys }: AppDeps): AnyRoute[] {
  const ownedIds = async (buyerId: string) =>
    new Set((await db.sale.findMany({ where: { buyerId, status: 'captured' }, select: { artifactId: true } })).map((s) => s.artifactId));
  const mySale = async (buyerId: string, saleId: string) => {
    const sale = await db.sale.findFirst({ where: { id: saleId, buyerId }, select: saleSelect });
    if (!sale) throw new HttpError(404, 'Checkout not found.');
    return sale;
  };

  const ANSWERS = 'Answers (pay-per-citation)';
  const topUpOut = async (topUpId: string): Promise<z.infer<typeof CreditTopUp>> => {
    const t = await db.creditTopUp.findUniqueOrThrow({ where: { id: topUpId } });
    return {
      id: t.id,
      object: 'credit_top_up',
      status: t.status,
      amount_cents: t.amountCents,
      paypal_order_id: t.orderId,
      approve_url: t.status === 'pending_payment' && t.orderId ? sandboxApproveUrl(t.orderId) : null,
      capture_id: t.captureId,
    };
  };

  return [
    defineRoute({
      method: 'get', path: '/libraries', operationId: 'listLibraries', roles: ['buyer'], tag: ANSWERS, summary: 'Libraries that answer questions',
      response: LibraryList,
      handler: async () => {
        const libs = await listLibraries(db);
        return { object: 'list' as const, data: libs.map((l) => ({ id: l.id, object: 'library' as const, name: l.name, sources_licensed_for_ai: l.sources })), has_more: false, next_cursor: null };
      },
    }),
    defineRoute({
      method: 'get', path: '/credits', operationId: 'getCredits', roles: ['buyer'], tag: ANSWERS, summary: 'Your answer credit',
      response: CreditBalance,
      handler: async ({ user }) => {
        const c = await creditSummary(db, user.id);
        return {
          object: 'credit_balance' as const,
          balance_cents: c.balanceCents,
          reserved_cents: c.reservedCents,
          available_cents: c.availableCents,
          entries: c.entries.map((e) => ({ id: e.id, kind: e.kind, amount_cents: e.amountCents, answer_id: e.answerId, top_up_id: e.topUpId, created: e.createdAt.toISOString() })),
        };
      },
    }),
    defineRoute({
      method: 'post', path: '/credit_top_ups', operationId: 'startCreditTopUp', roles: ['buyer'], middleware: [quotas.checkout()], tag: ANSWERS, summary: 'Buy answer credit with PayPal',
      description: 'Returns an `approve_url` for the buyer. After they approve at PayPal, call `POST /credit_top_ups/{id}/capture`.',
      body: z.object({ amount_cents: z.number().int().min(100).max(MAX_TOP_UP_CENTS) }),
      response: CreditTopUp, status: 201,
      handler: async ({ user, body }) => topUpOut((await startTopUp(db, paypal(), { ownerId: user.id, amountCents: body.amount_cents, appBaseUrl: config.appBaseUrl })).topUpId),
    }),
    defineRoute({
      method: 'post', path: '/credit_top_ups/:id/capture', operationId: 'captureCreditTopUp', roles: ['buyer'], tag: ANSWERS, summary: 'Complete a top-up the buyer approved',
      params: Id, body: z.object({}).strict(), response: CreditTopUp, errors: [409],
      handler: async ({ user, params }) => topUpOut((await captureTopUp(db, paypal(), params.id, user.id)).topUpId),
    }),
    defineRoute({
      method: 'post', path: '/answers', operationId: 'ask', roles: ['buyer'], middleware: [quotas.answer()], tag: ANSWERS, summary: 'Ask a question, paid per verified citation',
      description:
        'Answers only from sources licensed for AI answers. You pay a small fee plus each source’s rate for every passage the answer verifiably relies on — never more than `max_price_cents`, which is enforced before the model runs. `402 insufficient_credit` means top up first.',
      body: z.object({
        library_id: z.string().min(1).max(64),
        question: z.string().trim().min(8).max(500),
        max_price_cents: z.number().int().min(1).max(500).meta({ description: 'The most this answer may cost.' }),
      }),
      response: AnswerResource, status: 201, errors: [402],
      handler: async ({ user, body }) =>
        answerOutV1(await askLibrary(db, answerWriter(), signingKeys(), { askerId: user.id, libraryId: body.library_id, question: body.question, maxPriceCents: body.max_price_cents })),
    }),
    defineRoute({
      method: 'get', path: '/answers', operationId: 'listAnswers', roles: ['buyer'], tag: ANSWERS, summary: 'Your recent answers',
      response: AnswerSummaryList,
      handler: async ({ user }) => ({
        object: 'list' as const,
        data: (await listAnswers(db, user.id)).map((a) => ({ id: a.id, object: 'answer' as const, question: a.question, status: a.status, library_name: a.libraryName, charged_cents: a.chargedCents, created: a.createdAt.toISOString() })),
        has_more: false,
        next_cursor: null,
      }),
    }),
    defineRoute({
      method: 'get', path: '/answers/:id', operationId: 'getAnswer', roles: ['buyer'], tag: ANSWERS, summary: 'Retrieve an answer and its signed receipt',
      params: Id, response: AnswerResource,
      handler: async ({ user, params }) => answerOutV1(await getAnswer(db, params.id, user.id, signingKeys())),
    }),
    defineRoute({
      method: 'get', path: '/store/reports', operationId: 'searchStore', roles: ['buyer'], tag: TAG, summary: 'Search reports for sale',
      description: 'Reports currently for sale, best match first when you pass `query`.',
      query: z.object({
        query: z.string().max(200).optional().meta({ description: 'What you are looking for, in a few words.' }),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      response: StoreReportList,
      handler: async ({ user, query }) => {
        const owned = await ownedIds(user.id);
        const listed = await db.artifact.findMany({ where: { status: 'listed' }, orderBy: { createdAt: 'desc' }, take: 200 });
        const rows = listed.map((a) => {
          const c = a.content as unknown as ArtifactContent;
          const summary = c.sections.find((s) => s.key === 'summary')?.body ?? '';
          return storeReportOut(a, owned.has(a.id), query.query ? matchScore(query.query, `${a.title} ${summary}`) : null);
        });
        if (query.query) rows.sort((x, y) => (y.match ?? 0) - (x.match ?? 0));
        return { object: 'list' as const, data: rows.slice(0, query.limit), has_more: rows.length > query.limit, next_cursor: null };
      },
    }),
    defineRoute({
      method: 'get', path: '/store/reports/:id', operationId: 'getStoreReport', roles: ['buyer'], tag: TAG, summary: 'Check a report before buying',
      description: 'Re-runs the license check as of today. Includes the full content once you own the report.',
      params: Id, response: StoreReportDetail,
      handler: async ({ user, params }) => {
        const a = await db.artifact.findUnique({ where: { id: params.id } });
        const owned = a ? (await ownedIds(user.id)).has(a.id) : false;
        // Off-sale reports stay readable to people who bought them, and invisible to everyone else.
        if (!a || (a.status !== 'listed' && !owned)) throw new HttpError(404, 'Report not found.');
        const rights = a.status === 'listed' ? await db.$transaction((tx) => checkSaleRights(tx, a.id)) : null;
        const c = a.content as unknown as ArtifactContent;
        return {
          ...storeReportOut(a, owned, null),
          license_check: { valid_today: rights?.ok ?? false, problems: rights && !rights.ok ? rights.reasons : rights ? [] : ['The report is not for sale right now.'] },
          content: owned ? c.sections.map((s) => ({ heading: s.heading, body: s.body })) : null,
        };
      },
    }),
    defineRoute({
      method: 'post', path: '/checkouts', operationId: 'startCheckout', roles: ['buyer'], middleware: [quotas.checkout()], tag: TAG, summary: 'Start a checkout',
      description:
        'Creates (or reuses) a PayPal order for the report. The buyer must approve it at `approve_url` — software can’t. Then call `POST /checkouts/{id}/capture`.',
      body: z.object({ report_id: z.string().min(1).max(64) }),
      response: Checkout, status: 201, errors: [409],
      handler: async ({ user, body }) => {
        const started = await startCheckout(db, paypal(), { artifactId: body.report_id, buyerId: user.id, appBaseUrl: config.appBaseUrl });
        return checkoutOut(await mySale(user.id, started.saleId));
      },
    }),
    defineRoute({
      method: 'get', path: '/checkouts/:id', operationId: 'getCheckout', roles: ['buyer'], tag: TAG, summary: 'Retrieve a checkout',
      params: Id, response: Checkout,
      handler: async ({ user, params }) => checkoutOut(await mySale(user.id, params.id)),
    }),
    defineRoute({
      method: 'post', path: '/checkouts/:id/capture', operationId: 'captureCheckout', roles: ['buyer'], tag: TAG, summary: 'Complete a checkout the buyer approved',
      description: 'Captures the approved PayPal order and verifies amount, currency and reference. Safe to retry. `409 invalid_state` if the buyer hasn’t approved it yet.',
      params: Id, body: z.object({}).strict(), response: Checkout, errors: [409],
      handler: async ({ user, params }) => {
        await mySale(user.id, params.id);
        await captureSale(db, paypal(), params.id);
        return checkoutOut(await mySale(user.id, params.id));
      },
    }),
  ];
}
