import { z } from 'zod';
import type { AppDeps } from '../app';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';
import { matchScore } from '../modules/agent/buyer-tools';
import type { CitationReport } from '../modules/generation/citations';
import type { ArtifactContent } from '../modules/generation/generation.service';
import { captureSale, startCheckout } from '../modules/payments/payments.service';
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

export function buyerRoutes({ db, paypal, config }: AppDeps): AnyRoute[] {
  const ownedIds = async (buyerId: string) =>
    new Set((await db.sale.findMany({ where: { buyerId, status: 'captured' }, select: { artifactId: true } })).map((s) => s.artifactId));
  const mySale = async (buyerId: string, saleId: string) => {
    const sale = await db.sale.findFirst({ where: { id: saleId, buyerId }, select: saleSelect });
    if (!sale) throw new HttpError(404, 'Checkout not found.');
    return sale;
  };

  return [
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
