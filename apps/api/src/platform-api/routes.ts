import { z } from 'zod';
import type { AppDeps } from '../app';
import { ownedBuild, ownedSettlement, publisherScope, requireArtifactAccess } from '../http/access';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';
import type { AuthUser } from '../modules/auth/auth.service';
import { AgentStateError, createRun, decideReplacement, runAgent } from '../modules/agent/agent.service';
import { appendAudit } from '../modules/audit/audit-log';
import { buildReceipt } from '../modules/audit/receipt.service';
import { preflightAndRecord } from '../modules/builds/preflight.service';
import { listCatalog, parseTerms } from '../modules/catalog/catalog.service';
import { generateArtifact } from '../modules/generation/generation.service';
import { acceptOffer, declineOffer, requestLicense } from '../modules/licenses/license.service';
import { EVENT_TYPE_NAMES, EVENT_TYPES } from '../modules/platform/events';
import {
  createEndpoint, deleteEndpoint, deliverySelect, eventEnvelope, getEndpoint, resendEvent, retryDelivery, rotateSecret, sendTestEvent, updateEndpoint,
  type WebhookDeps,
} from '../modules/platform/webhooks';
import { getProvenance } from '../modules/provenance/provenance.service';
import {
  approveSettlement, recalculateSettlement, refreshPayouts, retryFailedPayouts, submitPayouts,
} from '../modules/settlements/settlement.service';
import { checkSaleRights, withdrawArtifact } from '../modules/sales/rights.service';
import { cursorWhere, defineRoute, ListQuery, pageOrder, toPage, type AnyRoute } from './framework';
import * as R from './resources';

const Id = (what: string) => z.object({ id: z.string().min(1).max(64).meta({ description: `The ${what} id.` }) });
const Empty = z.object({}).strict();
const MAX_ACTIVE_AGENT_RUNS = 2;

export interface PlatformDeps extends AppDeps {
  webhooks: () => WebhookDeps;
}

export function platformRoutes(deps: PlatformDeps): AnyRoute[] {
  const { db, paypal, signingKeys, writer, planner } = deps;

  const reportById = async (user: AuthUser, id: string) => {
    const artifact = await db.artifact.findFirst({ where: { id, buildJob: publisherScope(user) } });
    if (!artifact) throw new HttpError(404, 'Report not found.');
    return artifact;
  };
  const withdrawnReason = async (artifactId: string) => {
    const w = await db.auditEvent.findFirst({ where: { eventType: 'artifact.withdrawn', artifactId }, orderBy: { seq: 'desc' }, select: { payload: true } });
    return ((w?.payload as { reasons?: string[] } | undefined)?.reasons ?? [])[0] ?? null;
  };
  const settlementWithNames = async (runId: string) => {
    const run = await db.settlementRun.findUniqueOrThrow({ where: { id: runId }, include: R.settlementInclude });
    const users = await db.user.findMany({ where: { id: { in: run.lines.map((l) => l.recipientId) } }, select: { id: true, name: true } });
    return R.settlementOut(run, new Map(users.map((u) => [u.id, u.name])));
  };
  const licenseInclude = { asset: { select: { id: true, title: true, owner: { select: { name: true } } } } } as const;
  const licenseById = async (userId: string, id: string) => {
    const g = await db.licenseGrant.findFirst({ where: { id, licenseeId: userId }, include: licenseInclude });
    if (!g) throw new HttpError(404, 'License not found.');
    return R.licenseOut(g, parseTerms);
  };
  const runInBackground = (runId: string) => {
    void runAgent(db, planner(), writer(), runId).catch((err) => console.error(`agent run ${runId} crashed`, err));
  };

  return [
    // ---- account ------------------------------------------------------------------------------
    defineRoute({
      method: 'get', path: '/account', operationId: 'getAccount', tag: 'Account', summary: 'The account behind the credentials',
      response: R.Account,
      handler: async ({ req, user }) => ({
        id: user.id, object: 'account' as const, name: user.name, email: user.email, role: user.role,
        authenticated_with: req.authMethod ?? 'session',
        api_key: req.apiKey ? { id: req.apiKey.id, access: req.apiKey.access } : null,
      }),
    }),

    // ---- sources & licenses ----------------------------------------------------------------------
    defineRoute({
      method: 'get', path: '/sources', operationId: 'listSources', tag: 'Sources & licenses',
      summary: 'List licensable sources with your license status',
      description: 'Every source you hold a license for, plus the current marketplace (up to 500). Use `version.id` in `source_version_ids` when creating a build.',
      response: R.SourceList,
      handler: async ({ user }) => ({ object: 'list' as const, data: (await listCatalog(db, user.id)).map(R.sourceOut), has_more: false, next_cursor: null }),
    }),
    defineRoute({
      method: 'get', path: '/sources/:id', operationId: 'getSource', tag: 'Sources & licenses', summary: 'Retrieve a source',
      params: Id('source'), response: R.Source,
      handler: async ({ user, params }) => {
        const entry = (await listCatalog(db, user.id)).find((e) => e.assetId === params.id);
        if (!entry) throw new HttpError(404, 'Source not found.');
        return R.sourceOut(entry);
      },
    }),
    defineRoute({
      method: 'post', path: '/sources/:id/license_requests', operationId: 'requestLicense', middleware: [quotas.request()], tag: 'Sources & licenses',
      summary: 'Ask the source’s owner for a license',
      description: 'The owner answers with an offer (event `license.offered`), which you then accept or decline.',
      params: Id('source'), body: z.object({ message: z.string().max(1000).nullable().optional() }), response: R.License, status: 201,
      handler: async ({ user, params, body }) => {
        const grant = await requestLicense(db, { assetId: params.id, publisherId: user.id, message: body.message ?? null });
        return licenseById(user.id, grant.id);
      },
    }),
    defineRoute({
      method: 'get', path: '/licenses', operationId: 'listLicenses', tag: 'Sources & licenses', summary: 'List your licenses, requests and offers',
      query: ListQuery.extend({
        status: z.enum(['requested', 'offered', 'approved', 'declined', 'withdrawn', 'revoked', 'superseded']).optional(),
        source_id: z.string().max(64).optional(),
      }),
      response: R.LicenseList,
      handler: async ({ user, query }) => {
        const rows = await db.licenseGrant.findMany({
          where: { licenseeId: user.id, ...(query.status ? { status: query.status } : {}), ...(query.source_id ? { assetId: query.source_id } : {}), ...cursorWhere(query.starting_after) },
          orderBy: pageOrder, take: query.limit + 1, include: licenseInclude,
        });
        return toPage(rows, query.limit, (g) => R.licenseOut(g, parseTerms));
      },
    }),
    defineRoute({
      method: 'get', path: '/licenses/:id', operationId: 'getLicense', tag: 'Sources & licenses', summary: 'Retrieve a license',
      params: Id('license'), response: R.License,
      handler: async ({ user, params }) => licenseById(user.id, params.id),
    }),
    defineRoute({
      method: 'post', path: '/licenses/:id/accept', operationId: 'acceptLicense', tag: 'Sources & licenses', summary: 'Accept an offer',
      description: 'Binds exactly the terms you reviewed: `terms_hash` must equal the offer’s current hash, so terms that changed meanwhile can’t be accepted by accident.',
      params: Id('license'), body: z.object({ terms_hash: z.string().length(64) }), response: R.License,
      handler: async ({ user, params, body }) => {
        await acceptOffer(db, { grantId: params.id, publisherId: user.id, termsHash: body.terms_hash });
        return licenseById(user.id, params.id);
      },
    }),
    defineRoute({
      method: 'post', path: '/licenses/:id/decline', operationId: 'declineLicense', tag: 'Sources & licenses', summary: 'Decline an offer',
      params: Id('license'), body: z.object({ reason: z.string().max(500).nullable().optional() }), response: R.License,
      handler: async ({ user, params, body }) => {
        await declineOffer(db, { grantId: params.id, publisherId: user.id, reason: body.reason ?? null });
        return licenseById(user.id, params.id);
      },
    }),

    // ---- builds -------------------------------------------------------------------------------
    defineRoute({
      method: 'post', path: '/builds', operationId: 'createBuild', middleware: [quotas.preflight()], tag: 'Builds & reports', summary: 'Run the license preflight for a planned report',
      description: 'Evaluates every source’s license against the intent and records the result. The response is `201` whether it passed or was blocked: check `preflight.verdict`. Terms in force now are frozen onto the build.',
      body: z.object({ intent: R.IntentIn, source_version_ids: z.array(z.string().min(1).max(64)).min(1).max(20) }),
      response: R.Build, status: 201,
      handler: async ({ user, body }) => {
        const outcome = await db.$transaction((tx) => preflightAndRecord(tx, { publisherId: user.id, intent: R.intentIn(body.intent), assetVersionIds: body.source_version_ids }));
        return R.buildOut(await db.buildJob.findUniqueOrThrow({ where: { id: outcome.buildId }, select: R.buildSelect }));
      },
    }),
    defineRoute({
      method: 'get', path: '/builds', operationId: 'listBuilds', tag: 'Builds & reports', summary: 'List builds',
      query: ListQuery.extend({ status: z.enum(['preflight_blocked', 'preflight_passed', 'generating', 'generated', 'generation_failed']).optional() }),
      response: R.BuildList,
      handler: async ({ user, query }) => {
        const rows = await db.buildJob.findMany({
          where: { ...publisherScope(user), ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.starting_after) },
          orderBy: pageOrder, take: query.limit + 1, select: R.buildSelect,
        });
        return toPage(rows, query.limit, R.buildOut);
      },
    }),
    defineRoute({
      method: 'get', path: '/builds/:id', operationId: 'getBuild', tag: 'Builds & reports', summary: 'Retrieve a build',
      params: Id('build'), response: R.Build,
      handler: async ({ user, params }) => {
        await ownedBuild(db, user, params.id);
        return R.buildOut(await db.buildJob.findUniqueOrThrow({ where: { id: params.id }, select: R.buildSelect }));
      },
    }),
    defineRoute({
      method: 'post', path: '/builds/:id/generate', operationId: 'generateReport', tag: 'Builds & reports', summary: 'Generate the report for a passed build',
      description: 'Licenses are re-checked first; if one changed since the preflight, nothing is generated (`409`). Every citation is validated against the retrieved passages; a draft that fails validation is rejected (`422`, code `generation_failed`). A report built for sale is listed in the store.',
      params: Id('build'), body: Empty.optional(), response: R.Generation, status: 201, errors: [409, 422],
      handler: async ({ user, params }) => {
        await ownedBuild(db, user, params.id);
        const result = await generateArtifact(db, params.id, writer());
        if (!result.artifactId) {
          throw new HttpError(422, 'The draft failed citation validation, so no report was published. You can run the preflight again and retry.', {
            code: 'generation_failed',
            citation_errors: result.citationReport.errors,
            attempts: result.attempts,
          });
        }
        const artifact = await db.artifact.findUniqueOrThrow({ where: { id: result.artifactId } });
        return { object: 'generation' as const, build_id: params.id, report: R.reportOut(artifact), attempts: result.attempts, model: result.model, from_fixture: result.fromFixture };
      },
    }),

    // ---- reports ------------------------------------------------------------------------------
    defineRoute({
      method: 'get', path: '/reports', operationId: 'listReports', tag: 'Builds & reports', summary: 'List your reports',
      query: ListQuery.extend({ status: z.enum(['draft', 'listed', 'withdrawn']).optional() }),
      response: R.ReportList,
      handler: async ({ user, query }) => {
        const rows = await db.artifact.findMany({
          where: { buildJob: publisherScope(user), ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.starting_after) },
          orderBy: pageOrder, take: query.limit + 1,
        });
        const reasons = new Map(await Promise.all(rows.filter((a) => a.status === 'withdrawn').map(async (a) => [a.id, await withdrawnReason(a.id)] as const)));
        return toPage(rows, query.limit, (a) => R.reportOut(a, { withdrawnReason: reasons.get(a.id) ?? null }));
      },
    }),
    defineRoute({
      method: 'get', path: '/reports/:id', operationId: 'getReport', tag: 'Builds & reports', summary: 'Retrieve a report',
      params: Id('report'), query: z.object({ include: z.enum(['content']).optional().meta({ description: '`content` adds the full report text.' }) }),
      response: R.Report,
      handler: async ({ user, params, query }) => {
        const a = await reportById(user, params.id);
        return R.reportOut(a, { withdrawnReason: a.status === 'withdrawn' ? await withdrawnReason(a.id) : null, includeContent: query.include === 'content' });
      },
    }),
    defineRoute({
      method: 'post', path: '/reports/:id/withdraw', operationId: 'withdrawReport', tag: 'Builds & reports', summary: 'Take a report off sale',
      params: Id('report'), body: Empty.optional(), response: R.Report,
      handler: async ({ user, params }) => {
        await reportById(user, params.id);
        await db.$transaction((tx) => withdrawArtifact(tx, params.id, ['Withdrawn by the publisher.'], 'publisher'));
        const a = await reportById(user, params.id);
        return R.reportOut(a, { withdrawnReason: await withdrawnReason(a.id) });
      },
    }),
    defineRoute({
      method: 'post', path: '/reports/:id/relist', operationId: 'relistReport', tag: 'Builds & reports', summary: 'Put a report back on sale',
      description: 'Only if every source license still permits the sale today (`409` with the reasons otherwise).',
      params: Id('report'), body: Empty.optional(), response: R.Report, errors: [409],
      handler: async ({ user, params }) => {
        await reportById(user, params.id);
        const result = await db.$transaction(async (tx) => {
          const artifact = await tx.artifact.findUniqueOrThrow({ where: { id: params.id }, include: { buildJob: { select: { intent: true } } } });
          if ((artifact.buildJob.intent as { distribution?: string }).distribution !== 'sale') throw new HttpError(409, 'This report was built for internal use only.', { code: 'internal_only' });
          if (artifact.status === 'listed') return { ok: true as const };
          const rights = await checkSaleRights(tx, params.id);
          if (!rights.ok) return { ok: false as const, reasons: rights.reasons };
          await tx.artifact.update({ where: { id: params.id }, data: { status: 'listed' } });
          await appendAudit(tx, { entityType: 'artifact', entityId: params.id, artifactId: params.id, eventType: 'artifact.relisted', payload: {} });
          return { ok: true as const };
        });
        if (!result.ok) throw new HttpError(409, `It can’t be sold yet: ${result.reasons[0]}`, { code: 'rights_not_satisfied', reasons: result.reasons });
        return R.reportOut(await reportById(user, params.id));
      },
    }),
    defineRoute({
      method: 'get', path: '/reports/:id/receipt', operationId: 'getReceipt', tag: 'Builds & reports', summary: 'Get the signed audit receipt',
      description: 'Verify it offline: Ed25519 over the canonical JSON of `document`, with `public_key_pem` (also at `GET /api/audit/public-key`).',
      params: Id('report'), response: R.Receipt,
      handler: async ({ user, params }) => {
        await requireArtifactAccess(db, user, params.id, ['owner']);
        const receipt = await buildReceipt(db, params.id, signingKeys(), { level: 'owner', userId: user.id, ownAssetVersionIds: new Set() });
        if (!receipt) throw new HttpError(404, 'Report not found.');
        return { object: 'receipt' as const, algorithm: receipt.algorithm, document: receipt.document, signature: receipt.signature, public_key_pem: receipt.publicKeyPem };
      },
    }),
    defineRoute({
      method: 'get', path: '/reports/:id/provenance', operationId: 'getProvenance', tag: 'Builds & reports', summary: 'Get the provenance graph',
      params: Id('report'), response: R.Provenance,
      handler: async ({ user, params }) => {
        await requireArtifactAccess(db, user, params.id, ['owner']);
        const graph = await getProvenance(db, params.id);
        if (!graph) throw new HttpError(404, 'Report not found.');
        return { object: 'provenance' as const, report_id: params.id, nodes: graph.nodes as unknown as Record<string, unknown>[], edges: graph.edges as unknown as Record<string, unknown>[] };
      },
    }),

    // ---- sales & settlements ----------------------------------------------------------------------
    defineRoute({
      method: 'get', path: '/sales', operationId: 'listSales', tag: 'Sales & settlements', summary: 'List sales of your reports',
      query: ListQuery.extend({ status: z.enum(['pending_payment', 'captured', 'payment_failed', 'refunded', 'exception']).optional(), report_id: z.string().max(64).optional() }),
      response: R.SaleList,
      handler: async ({ user, query }) => {
        const rows = await db.sale.findMany({
          where: {
            artifact: { buildJob: publisherScope(user) },
            ...(query.status ? { status: query.status } : {}),
            ...(query.report_id ? { artifactId: query.report_id } : {}),
            ...cursorWhere(query.starting_after),
          },
          orderBy: pageOrder, take: query.limit + 1, select: R.saleSelect,
        });
        return toPage(rows, query.limit, R.saleOut);
      },
    }),
    defineRoute({
      method: 'get', path: '/sales/:id', operationId: 'getSale', tag: 'Sales & settlements', summary: 'Retrieve a sale',
      params: Id('sale'), response: R.Sale,
      handler: async ({ user, params }) => {
        const sale = await db.sale.findFirst({ where: { id: params.id, artifact: { buildJob: publisherScope(user) } }, select: R.saleSelect });
        if (!sale) throw new HttpError(404, 'Sale not found.');
        return R.saleOut(sale);
      },
    }),
    defineRoute({
      method: 'get', path: '/settlements', operationId: 'listSettlements', tag: 'Sales & settlements', summary: 'List settlements',
      query: ListQuery.extend({ status: z.enum(['calculated', 'approved', 'payout_submitted', 'completed', 'exception']).optional() }),
      response: R.SettlementList,
      handler: async ({ user, query }) => {
        const rows = await db.settlementRun.findMany({
          where: { sale: { artifact: { buildJob: publisherScope(user) } }, ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.starting_after) },
          orderBy: pageOrder, take: query.limit + 1, include: R.settlementInclude,
        });
        const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.lines.map((l) => l.recipientId)))] } }, select: { id: true, name: true } });
        const names = new Map(users.map((u) => [u.id, u.name]));
        return toPage(rows, query.limit, (r) => R.settlementOut(r, names));
      },
    }),
    defineRoute({
      method: 'get', path: '/settlements/:id', operationId: 'getSettlement', tag: 'Sales & settlements', summary: 'Retrieve a settlement',
      params: Id('settlement'), response: R.Settlement,
      handler: async ({ user, params }) => {
        await ownedSettlement(db, user, params.id);
        return settlementWithNames(params.id);
      },
    }),
    defineRoute({
      method: 'post', path: '/settlements/:id/approve', operationId: 'approveSettlement', tag: 'Sales & settlements', summary: 'Approve a calculated settlement',
      params: Id('settlement'), body: Empty.optional(), response: R.Settlement, errors: [409],
      handler: async ({ user, params }) => {
        await ownedSettlement(db, user, params.id);
        await approveSettlement(db, params.id, user.id);
        return settlementWithNames(params.id);
      },
    }),
    defineRoute({
      method: 'post', path: '/settlements/:id/payouts', operationId: 'sendPayouts', tag: 'Sales & settlements', summary: 'Send the PayPal payouts of an approved settlement',
      description: 'Safe to retry: the PayPal batch id is deterministic, so PayPal never pays the same batch twice. Final statuses arrive via `payout_batch.updated` events.',
      params: Id('settlement'), body: Empty.optional(), response: R.Settlement, status: 201, errors: [409, 502, 503],
      handler: async ({ user, params }) => {
        await ownedSettlement(db, user, params.id);
        await submitPayouts(db, paypal(), params.id);
        return settlementWithNames(params.id);
      },
    }),
    defineRoute({
      method: 'post', path: '/settlements/:id/refresh', operationId: 'refreshPayouts', tag: 'Sales & settlements', summary: 'Fetch the latest payout statuses from PayPal',
      params: Id('settlement'), body: Empty.optional(), response: R.Settlement, errors: [409, 502],
      handler: async ({ user, params }) => {
        await ownedSettlement(db, user, params.id);
        await refreshPayouts(db, paypal(), params.id);
        return settlementWithNames(params.id);
      },
    }),
    defineRoute({
      method: 'post', path: '/settlements/:id/retry_failed', operationId: 'retryFailedPayouts', tag: 'Sales & settlements', summary: 'Re-send only the payouts that failed',
      description: 'Creates a new numbered attempt for payouts PayPal reported as failed, returned or blocked, to the contributors’ current addresses.',
      params: Id('settlement'), body: Empty.optional(), response: R.Settlement, status: 201, errors: [409, 502],
      handler: async ({ user, params }) => {
        await ownedSettlement(db, user, params.id);
        await retryFailedPayouts(db, paypal(), params.id);
        return settlementWithNames(params.id);
      },
    }),
    defineRoute({
      method: 'post', path: '/settlements/:id/recalculate', operationId: 'recalculateSettlement', tag: 'Sales & settlements', summary: 'Recalculate a failed settlement',
      params: Id('settlement'), body: Empty.optional(), response: R.Settlement, errors: [409],
      handler: async ({ user, params }) => {
        await ownedSettlement(db, user, params.id);
        const fresh = await recalculateSettlement(db, params.id);
        return settlementWithNames(fresh.id);
      },
    }),

    // ---- agent ---------------------------------------------------------------------------------
    defineRoute({
      method: 'post', path: '/agent_runs', operationId: 'startAgentRun', middleware: [quotas.agentRun()], tag: 'Publisher Agent', summary: 'Start a Publisher Agent run',
      description: 'Runs in the background (`202`). Follow it with `GET /agent_runs/{id}` or the `agent_run.*` events; a run waiting for you has status `awaiting_approval`.',
      body: z.object({
        goal: z.string().min(10).max(2000),
        intent: R.IntentIn,
        source_version_ids: z.array(z.string().min(1).max(64)).min(1).max(20),
        auto_replace: z.boolean().default(false).meta({ description: 'Let the agent swap a blocked source for a licensed one without asking.' }),
      }),
      response: R.AgentRun, status: 202, errors: [429],
      handler: async ({ user, body }) => {
        const active = await db.agentRun.count({ where: { publisherId: user.id, status: 'running' } });
        if (active >= MAX_ACTIVE_AGENT_RUNS) throw new HttpError(429, `You already have ${active} agent runs in progress. Wait for one to finish.`, { code: 'too_many_active_runs' });
        const run = await createRun(db, planner(), {
          publisherId: user.id, goal: body.goal, intent: R.intentIn(body.intent), selection: body.source_version_ids, policy: { autoReplace: body.auto_replace },
        });
        runInBackground(run.id);
        return R.agentRunOut(await db.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: R.agentRunSelect }));
      },
    }),
    defineRoute({
      method: 'get', path: '/agent_runs', operationId: 'listAgentRuns', tag: 'Publisher Agent', summary: 'List agent runs',
      query: ListQuery, response: R.AgentRunList,
      handler: async ({ user, query }) => {
        const rows = await db.agentRun.findMany({ where: { ...publisherScope(user), ...cursorWhere(query.starting_after) }, orderBy: pageOrder, take: query.limit + 1, select: R.agentRunSelect });
        return toPage(rows, query.limit, R.agentRunOut);
      },
    }),
    defineRoute({
      method: 'get', path: '/agent_runs/:id', operationId: 'getAgentRun', tag: 'Publisher Agent', summary: 'Retrieve an agent run',
      params: Id('agent run'), response: R.AgentRun,
      handler: async ({ user, params }) => {
        const run = await db.agentRun.findFirst({ where: { id: params.id, ...publisherScope(user) }, select: R.agentRunSelect });
        if (!run) throw new HttpError(404, 'Agent run not found.');
        return R.agentRunOut(run);
      },
    }),
    defineRoute({
      method: 'post', path: '/agent_runs/:id/decision', operationId: 'decideAgentRun', tag: 'Publisher Agent', summary: 'Approve or decline what the agent proposes',
      params: Id('agent run'), body: z.object({ approved: z.boolean() }), response: R.AgentRun, status: 202, errors: [409],
      handler: async ({ user, params, body }) => {
        const owned = await db.agentRun.findFirst({ where: { id: params.id, ...publisherScope(user) }, select: { id: true } });
        if (!owned) throw new HttpError(404, 'Agent run not found.');
        try {
          await decideReplacement(db, params.id, user.id, body.approved);
        } catch (err) {
          if (err instanceof AgentStateError) throw new HttpError(409, err.message, { code: 'not_awaiting_approval' });
          throw err;
        }
        runInBackground(params.id);
        return R.agentRunOut(await db.agentRun.findUniqueOrThrow({ where: { id: params.id }, select: R.agentRunSelect }));
      },
    }),

    // ---- events ----------------------------------------------------------------------------------
    defineRoute({
      method: 'get', path: '/event_types', operationId: 'listEventTypes', tag: 'Events & webhooks', summary: 'List every event type',
      response: R.EventTypeList,
      handler: async () => ({ object: 'list' as const, data: EVENT_TYPES, has_more: false as const, next_cursor: null }),
    }),
    defineRoute({
      method: 'get', path: '/events', operationId: 'listEvents', tag: 'Events & webhooks', summary: 'List events (last 30 days)',
      description: 'Newest first. The same events webhooks deliver — use this to backfill anything an endpoint missed.',
      query: ListQuery.extend({
        type: z.string().max(100).optional().meta({ description: 'Only this event type.' }),
        object_id: z.string().max(64).optional().meta({ description: 'Only events about this object (e.g. a sale id).' }),
      }),
      response: R.EventList,
      handler: async ({ user, query }) => {
        if (query.type && !EVENT_TYPE_NAMES.has(query.type)) throw new HttpError(400, `Unknown event type: ${query.type}.`, { code: 'parameter_invalid', param: 'type' });
        const rows = await db.outboundEvent.findMany({
          where: {
            ownerId: user.id,
            ...(query.type ? { type: query.type } : {}),
            ...(query.object_id ? { data: { path: ['object_id'], equals: query.object_id } } : {}),
            ...cursorWhere(query.starting_after),
          },
          orderBy: pageOrder, take: query.limit + 1,
        });
        return toPage(rows, query.limit, eventEnvelope);
      },
    }),
    defineRoute({
      method: 'get', path: '/events/:id', operationId: 'getEvent', tag: 'Events & webhooks', summary: 'Retrieve an event',
      params: Id('event'), response: R.Event,
      handler: async ({ user, params }) => {
        const e = await db.outboundEvent.findFirst({ where: { id: params.id, ownerId: user.id } });
        if (!e) throw new HttpError(404, 'Event not found.');
        return eventEnvelope(e);
      },
    }),
    defineRoute({
      method: 'post', path: '/events/:id/resend', operationId: 'resendEvent', middleware: [quotas.webhookResend()], tag: 'Events & webhooks', summary: 'Send an event to an endpoint again',
      description: 'Queues the event for one endpoint — also one created after the event happened.',
      params: Id('event'), body: z.object({ endpoint_id: z.string().min(1).max(64) }), response: R.WebhookDelivery, status: 202, errors: [409],
      handler: async ({ user, params, body }) => R.deliveryOut(await resendEvent(db, user.id, params.id, body.endpoint_id)),
    }),

    // ---- webhook endpoints -----------------------------------------------------------------------
    defineRoute({
      method: 'post', path: '/webhook_endpoints', operationId: 'createWebhookEndpoint', middleware: [quotas.webhookManage()], tag: 'Events & webhooks', summary: 'Add a webhook endpoint',
      description: 'The response contains the signing `secret` — the only time it is shown. Verify every delivery with it (see the `TracePay-Signature` scheme in the API description).',
      body: z.object({
        url: z.string().min(1).max(2048).meta({ description: 'Public https URL that receives POSTs.' }),
        description: z.string().max(200).nullable().optional(),
        enabled_events: z.array(z.string().max(100)).min(1).max(100).meta({ description: 'Event types to receive, or `["*"]` for all.' }),
      }),
      response: R.WebhookEndpointWithSecret, status: 201, errors: [409],
      handler: async ({ user, body }) => {
        const { endpoint, secret } = await createEndpoint(deps.webhooks(), user.id, { url: body.url, description: body.description ?? null, enabledEvents: body.enabled_events });
        return { ...R.endpointOut(endpoint), secret };
      },
    }),
    defineRoute({
      method: 'get', path: '/webhook_endpoints', operationId: 'listWebhookEndpoints', tag: 'Events & webhooks', summary: 'List webhook endpoints',
      response: R.WebhookEndpointList,
      handler: async ({ user }) => {
        const rows = await db.webhookEndpoint.findMany({ where: { ownerId: user.id }, orderBy: pageOrder, select: { id: true } });
        const endpoints = await Promise.all(rows.map((r) => getEndpoint(db, user.id, r.id)));
        return { object: 'list' as const, data: endpoints.map(R.endpointOut), has_more: false, next_cursor: null };
      },
    }),
    defineRoute({
      method: 'get', path: '/webhook_endpoints/:id', operationId: 'getWebhookEndpoint', tag: 'Events & webhooks', summary: 'Retrieve a webhook endpoint',
      params: Id('endpoint'), response: R.WebhookEndpoint,
      handler: async ({ user, params }) => R.endpointOut(await getEndpoint(db, user.id, params.id)),
    }),
    defineRoute({
      method: 'patch', path: '/webhook_endpoints/:id', operationId: 'updateWebhookEndpoint', middleware: [quotas.webhookManage()], tag: 'Events & webhooks', summary: 'Update a webhook endpoint',
      description: 'Set `status` to `disabled` to pause deliveries, or back to `enabled` to resume (this also clears the failure streak). Deliveries skipped while disabled can be retried individually.',
      params: Id('endpoint'),
      body: z
        .object({
          url: z.string().min(1).max(2048).optional(),
          description: z.string().max(200).nullable().optional(),
          enabled_events: z.array(z.string().max(100)).min(1).max(100).optional(),
          status: z.enum(['enabled', 'disabled']).optional(),
        })
        .refine((b) => Object.keys(b).length > 0, { message: 'Send at least one field to change.' }),
      response: R.WebhookEndpoint, errors: [409],
      handler: async ({ user, params, body }) =>
        R.endpointOut(await updateEndpoint(deps.webhooks(), user.id, params.id, { url: body.url, description: body.description, enabledEvents: body.enabled_events, status: body.status })),
    }),
    defineRoute({
      method: 'delete', path: '/webhook_endpoints/:id', operationId: 'deleteWebhookEndpoint', tag: 'Events & webhooks', summary: 'Delete a webhook endpoint',
      description: 'Pending deliveries to it are dropped.',
      params: Id('endpoint'), response: R.Deleted,
      handler: async ({ user, params }) => {
        await deleteEndpoint(db, user.id, params.id);
        return { id: params.id, object: 'webhook_endpoint', deleted: true as const };
      },
    }),
    defineRoute({
      method: 'post', path: '/webhook_endpoints/:id/rotate_secret', operationId: 'rotateWebhookSecret', middleware: [quotas.webhookManage()], tag: 'Events & webhooks', summary: 'Rotate the signing secret',
      description: 'Returns the new secret (shown once). The old one keeps signing alongside it for `previous_secret_valid_hours` (default 24, 0 = stop now), so you can switch without missing events.',
      params: Id('endpoint'),
      body: z.object({ previous_secret_valid_hours: z.number().int().min(0).max(168).default(24) }),
      response: R.WebhookEndpointWithSecret,
      handler: async ({ user, params, body }) => {
        const { endpoint, secret } = await rotateSecret(deps.webhooks(), user.id, params.id, body.previous_secret_valid_hours);
        return { ...R.endpointOut(endpoint), secret };
      },
    }),
    defineRoute({
      method: 'post', path: '/webhook_endpoints/:id/test', operationId: 'testWebhookEndpoint', middleware: [quotas.webhookTest()], tag: 'Events & webhooks', summary: 'Send a test `ping` event now',
      description: 'Delivers immediately and returns the outcome, including the status code your endpoint answered with.',
      params: Id('endpoint'), body: Empty.optional(), response: R.WebhookDelivery, errors: [409],
      handler: async ({ user, params }) => R.deliveryOut(await sendTestEvent(deps.webhooks(), user.id, params.id)),
    }),
    defineRoute({
      method: 'get', path: '/webhook_endpoints/:id/deliveries', operationId: 'listWebhookDeliveries', tag: 'Events & webhooks', summary: 'List an endpoint’s deliveries',
      params: Id('endpoint'),
      query: ListQuery.extend({ status: z.enum(['pending', 'succeeded', 'failed', 'skipped']).optional() }),
      response: R.WebhookDeliveryList,
      handler: async ({ user, params, query }) => {
        await getEndpoint(db, user.id, params.id);
        const rows = await db.webhookDelivery.findMany({
          where: { endpointId: params.id, ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.starting_after) },
          orderBy: pageOrder, take: query.limit + 1, select: deliverySelect,
        });
        return toPage(rows, query.limit, R.deliveryOut);
      },
    }),
    defineRoute({
      method: 'post', path: '/webhook_deliveries/:id/retry', operationId: 'retryWebhookDelivery', middleware: [quotas.webhookResend()], tag: 'Events & webhooks', summary: 'Retry a failed or skipped delivery',
      params: Id('delivery'), body: Empty.optional(), response: R.WebhookDelivery, status: 202, errors: [409],
      handler: async ({ user, params }) => R.deliveryOut(await retryDelivery(db, user.id, params.id)),
    }),
  ];
}

