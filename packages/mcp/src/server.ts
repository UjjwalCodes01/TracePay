#!/usr/bin/env node
/**
 * TracePay MCP server: lets an AI agent (Claude Desktop, an IDE agent, …) shop for
 * licensed research reports on a buyer's behalf, through TracePay's Platform API.
 *
 * The agent can search, check a report's licenses and start a checkout. It can never
 * pay: the buyer approves every payment at PayPal's approve link, and the agent only
 * completes a checkout the buyer has already approved. A per-purchase price cap
 * (TRACEPAY_MAX_PRICE_CENTS) is enforced here as well.
 *
 *   TRACEPAY_API_KEY          a buyer account's API key (Developers page)       required
 *   TRACEPAY_API_URL          default https://trace-pay-umber.vercel.app/api/v1
 *   TRACEPAY_MAX_PRICE_CENTS  the most one purchase may cost, default 5000 ($50)
 *
 * Runs on Node 24+ directly (TypeScript type stripping): node packages/mcp/src/server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.TRACEPAY_API_URL || 'https://trace-pay-umber.vercel.app/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.TRACEPAY_API_KEY ?? '';
const MAX_PRICE_CENTS = Number(process.env.TRACEPAY_MAX_PRICE_CENTS || 5000);

interface StoreReport {
  id: string;
  title: string;
  summary: string | null;
  price_cents: number;
  currency: string;
  section_headings: string[];
  sources: Array<{ title: string; cited: boolean }>;
  citations_ok: boolean;
  written_by: { model: string; ai: boolean };
  owned: boolean;
  match: number | null;
}
interface StoreReportDetail extends StoreReport {
  license_check: { valid_today: boolean; problems: string[] };
  content: Array<{ heading: string; body: string }> | null;
}
interface Checkout {
  id: string;
  report_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  approve_url: string | null;
  capture_id: string | null;
  next_step: string;
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!API_KEY) throw new ApiError(401, 'unauthenticated', 'TRACEPAY_API_KEY is not set. Create a key on the Developers page of a TracePay buyer account.');
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000), // a sleeping free-tier server can take ~45 s to wake
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, 'bad_response', `TracePay answered with something other than JSON (HTTP ${res.status}). It may be starting up; try again in a minute.`);
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `HTTP ${res.status}`);
  }
  return json as T;
}

const money = (cents: number, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/** A tool result: readable text for the model, plus the data as structured content. */
const result = (text: string, data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text }], structuredContent: data });
const failure = (err: unknown) => ({
  content: [{ type: 'text' as const, text: err instanceof ApiError ? `TracePay refused (${err.code}): ${err.message}` : `Failed: ${(err as Error).message}` }],
  isError: true,
});

const server = new McpServer({ name: 'tracepay', version: '0.1.0' });

server.registerTool(
  'search_reports',
  {
    title: 'Search TracePay reports',
    description:
      'Search research reports for sale on TracePay. Every report is built only from licensed sources, and part of each sale pays the people whose work it uses. Returns ids, titles, prices and how well each matches.',
    inputSchema: { query: z.string().max(200).describe('What the user is looking for, in a few words.'), limit: z.number().int().min(1).max(20).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, limit }) => {
    try {
      const page = await api<{ data: StoreReport[] }>('GET', `/store/reports?${new URLSearchParams({ query, limit: String(limit ?? 10) })}`);
      const rows = page.data;
      const text = rows.length
        ? rows
            .map(
              (r) =>
                `- ${r.title} — ${money(r.price_cents, r.currency)}${r.owned ? ' (already owned)' : ''}${r.price_cents > MAX_PRICE_CENTS ? ' (over the price cap)' : ''}\n  id: ${r.id} · match ${r.match ?? 0} · ${r.sources.length} licensed sources · citations ${r.citations_ok ? 'verified' : 'NOT verified'}\n  ${r.summary?.slice(0, 240) ?? ''}`,
            )
            .join('\n')
        : 'No reports are for sale right now.';
      return result(`${text}\n\nPrice cap per purchase: ${money(MAX_PRICE_CENTS)}.`, { reports: rows, max_price_cents: MAX_PRICE_CENTS });
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'check_report',
  {
    title: 'Check a report before buying (or read one you own)',
    description:
      'Re-runs TracePay’s license compiler on the report’s sources as of today, and lists its sections, sources and citation check. If the user already owns it, returns the full report text.',
    inputSchema: { report_id: z.string().min(1).max(64) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ report_id }) => {
    try {
      const r = await api<StoreReportDetail>('GET', `/store/reports/${encodeURIComponent(report_id)}`);
      const lines = [
        `${r.title} — ${money(r.price_cents, r.currency)}${r.owned ? ' (owned)' : ''}`,
        `License check today: ${r.license_check.valid_today ? 'every source is licensed for this sale' : `NOT sellable: ${r.license_check.problems.join(' ')}`}`,
        `Citations: ${r.citations_ok ? 'every citation resolves to a licensed source' : 'NOT verified'}`,
        `Written by: ${r.written_by.ai ? r.written_by.model : 'extractive fallback (no AI model)'}`,
        `Sources: ${r.sources.map((s) => s.title).join('; ')}`,
        `Sections: ${r.section_headings.join('; ')}`,
      ];
      if (r.content) lines.push('', ...r.content.map((s) => `## ${s.heading}\n${s.body}`));
      return result(lines.join('\n'), { report: r });
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'start_checkout',
  {
    title: 'Start buying a report',
    description:
      'Creates a PayPal checkout for one report and returns an approve link. YOU CANNOT PAY: show the link to the user and ask them to approve the payment at PayPal, then call complete_checkout. Refused over the price cap, if the licenses no longer permit the sale, or if the user already owns it.',
    inputSchema: { report_id: z.string().min(1).max(64), reason: z.string().max(600).describe('Why this report fits what the user asked for — tell the user this too.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ report_id, reason }) => {
    try {
      const r = await api<StoreReportDetail>('GET', `/store/reports/${encodeURIComponent(report_id)}`);
      if (r.owned) return result('The user already owns this report. Use check_report to read it.', { owned: true });
      if (r.price_cents > MAX_PRICE_CENTS) {
        return failure(new ApiError(409, 'over_price_cap', `It costs ${money(r.price_cents, r.currency)}, over this agent’s cap of ${money(MAX_PRICE_CENTS)}. Ask the user to raise TRACEPAY_MAX_PRICE_CENTS if they want it.`));
      }
      if (!r.license_check.valid_today) return failure(new ApiError(409, 'not_for_sale', `Its licenses don’t permit a sale today: ${r.license_check.problems.join(' ')}`));
      // TracePay reuses the user's open checkout for the report, so retrying never opens a second one.
      const c = await api<Checkout>('POST', '/checkouts', { report_id });
      if (c.status === 'captured') return result('Already paid. The report is unlocked: use check_report to read it.', { checkout: c });
      return result(
        [
          `Checkout ready: "${r.title}" for ${money(c.amount_cents, c.currency)}.`,
          `Why: ${reason}`,
          '',
          c.approve_url
            ? `Ask the user to open this link and approve the payment in PayPal (sandbox):\n${c.approve_url}`
            : c.next_step,
          '',
          `When they have approved it, call complete_checkout with checkout_id "${c.id}".`,
        ].join('\n'),
        { checkout: c },
      );
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  'complete_checkout',
  {
    title: 'Complete a checkout the user approved',
    description: 'After the user approved the payment at PayPal: TracePay captures it and verifies amount, currency and reference, then unlocks the report. Safe to call again.',
    inputSchema: { checkout_id: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ checkout_id }) => {
    try {
      const c = await api<Checkout>('POST', `/checkouts/${encodeURIComponent(checkout_id)}/capture`, {});
      const text =
        c.status === 'captured'
          ? `Paid and verified with PayPal (capture ${c.capture_id}). ${money(c.amount_cents, c.currency)} — part of it goes to the report’s contributors. Use check_report with report_id "${c.report_id}" to read it.`
          : c.next_step;
      return result(text, { checkout: c });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_state') {
        return failure(new ApiError(409, 'not_approved', 'The user hasn’t approved the payment at PayPal yet. Ask them to open the approve link first.'));
      }
      return failure(err);
    }
  },
);

server.registerTool(
  'checkout_status',
  {
    title: 'Check a checkout',
    description: 'Where a checkout stands, and what happens next.',
    inputSchema: { checkout_id: z.string().min(1).max(64) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ checkout_id }) => {
    try {
      const c = await api<Checkout>('GET', `/checkouts/${encodeURIComponent(checkout_id)}`);
      return result(`${c.status}: ${c.next_step}${c.approve_url ? `\nApprove link: ${c.approve_url}` : ''}`, { checkout: c });
    } catch (err) {
      return failure(err);
    }
  },
);

await server.connect(new StdioServerTransport());
