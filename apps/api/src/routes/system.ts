import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppDeps } from '../app';
import { sandboxBuyerHint } from '../config/env';
import { currentUser, requireRole } from '../http/auth';
import { HttpError } from '../http/errors';
import { verifyAuditChain, verifyAuditChainCached } from '../modules/audit/audit-log';
import { publicKeyPem } from '../modules/audit/signing';
import { softResetDemo } from '../modules/demo/soft-reset';
import { DEMO_USERS } from '../modules/demo/world';
import { limitStore, limitStoreStatus } from '../http/rate-store';

export function systemRoutes({ db, config, signingKeys, writer, planner }: AppDeps) {
  const r = Router();

  r.get('/health', (_req, res) => {
    // The deployed commit (Render provides it), so it's always clear which version is live.
    res.json({ ok: true, service: 'tracepay-api', paypalEnv: 'sandbox', commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null });
  });

  /** Readiness: the process is up AND can reach the database. */
  r.get('/ready', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      // Rate limits fail open, so a Redis outage doesn't make the API unready; it's reported.
      res.json({ ok: true, rateLimits: limitStoreStatus() });
    } catch {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  /** Public, non-secret configuration the web app needs at startup. */
  r.get('/config', (_req, res) => {
    res.json({
      paypalEnv: 'sandbox',
      paypalClientId: config.paypalClientId,
      generation: writer().name,
      agentPlanner: planner().name,
      vertexReady: config.vertexReady,
      demoMode: config.demoMode,
      /** Every visitor shares the demo buyer: it may buy a report again, and its demo credit refills. */
      demoSharedBuyer: !!config.demoSharedBuyer,
      sandboxBuyerHint: config.demoMode ? sandboxBuyerHint() : null,
    });
  });

  r.get('/demo/users', async (_req, res) => {
    if (!config.demoMode) return res.json({ users: [] });
    // Only the seeded, non-admin personas — never real accounts.
    const users = await db.user.findMany({
      where: { id: { in: DEMO_USERS.filter((u) => u.role !== 'admin').map((u) => u.id) } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, role: true, email: true },
    });
    res.json({ users });
  });

  /**
   * Restores the demo publisher's world. Scoped: real accounts and their data are
   * never touched, and PayPal sandbox history is not reversed.
   */
  // A reset wipes everyone's shared demo state: a few per visitor (by IP) per 10 minutes.
  const resetLimiter = rateLimit({
    ...limitStore('demo-reset'),
    windowMs: 10 * 60_000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'The demo was reset several times just now. Try again in a few minutes.', { code: 'rate_limited' }, 600)),
  });
  r.post('/demo/reset', requireRole('publisher', 'admin'), resetLimiter, async (req, res) => {
    if (!config.demoMode) throw new HttpError(404, 'Not found.');
    if (req.authMethod !== 'demo' && req.user?.role !== 'admin') throw new HttpError(403, 'Only demo users can reset the demo.');
    const result = await softResetDemo(db);
    res.json({ ok: true, ...result, note: 'Demo data restored. Real accounts were not affected; PayPal sandbox history is not reversed.' });
  });

  r.get('/dashboard', requireRole('publisher', 'admin'), async (req, res) => {
    const user = currentUser(req);
    // Everything below is scoped to this publisher; admins see the whole system.
    const mine = user.role === 'admin' ? {} : { publisherId: user.id };
    const mySale = user.role === 'admin' ? {} : { artifact: { buildJob: { publisherId: user.id } } };
    const lastResetSeq = (await db.auditEvent.findFirst({ where: { eventType: 'demo.reset' }, orderBy: { seq: 'desc' }, select: { seq: true } }))?.seq ?? 0;
    const myRun = user.role === 'admin' ? {} : { sale: mySale };

    const [buildsPassed, buildsBlocked, artifacts, sales, owed, paid, exceptions, recent, toApprove, toPay, paying, agentWaiting, latestArtifact] = await Promise.all([
      db.buildJob.count({ where: { ...mine, status: { in: ['preflight_passed', 'generating', 'generated'] } } }),
      db.buildJob.count({ where: { ...mine, status: 'preflight_blocked' } }),
      db.artifact.count({ where: { buildJob: mine } }),
      db.payPalPayment.aggregate({ where: { sale: { ...mySale, status: 'captured' } }, _count: true, _sum: { capturedCents: true } }),
      db.settlementLine.aggregate({
        where: {
          kind: 'contributor',
          payable: true,
          run: { ...myRun, status: { in: ['calculated', 'approved', 'payout_submitted'] } },
          OR: [{ payoutItem: null }, { payoutItem: { status: { not: 'SUCCESS' } } }],
        },
        _sum: { amountCents: true },
      }),
      db.payoutItem.aggregate({ where: { status: 'SUCCESS', batch: { run: myRun } }, _sum: { amountCents: true }, _count: true }),
      db.settlementRun.count({ where: { ...myRun, status: 'exception' } }),
      db.auditEvent.findMany({
        // Publishers see only their own events; system events (no tenant) are for admins.
        where: {
          eventType: { notIn: ['sale.created'] },
          ...(user.role === 'admin' ? {} : { tenantId: user.id }),
          ...(req.authMethod === 'demo' ? { seq: { gt: lastResetSeq } } : {}),
        },
        orderBy: { seq: 'desc' },
        take: 12,
        select: { seq: true, eventType: true, entityType: true, entityId: true, createdAt: true, hash: true, payload: true },
      }),
      db.settlementRun.count({ where: { ...myRun, status: 'calculated' } }),
      db.settlementRun.count({ where: { ...myRun, status: 'approved' } }),
      db.settlementRun.count({ where: { ...myRun, status: 'payout_submitted' } }),
      db.agentRun.count({ where: { ...mine, kind: 'publisher', status: 'awaiting_approval' } }),
      db.artifact.findFirst({ where: { buildJob: mine }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true } }),
    ]);
    const licenseOffers = await db.licenseGrant.count({ where: { status: 'offered', ...(user.role === 'admin' ? {} : { licenseeId: user.id }) } });
    res.json({
      licenseOffers,
      settlementsToApprove: toApprove,
      settlementsToPay: toPay,
      payoutsInProgress: paying,
      agentWaiting,
      latestArtifact,
      buildsPassed,
      buildsBlocked,
      artifacts,
      verifiedSales: sales._count,
      verifiedSalesCents: sales._sum.capturedCents ?? 0,
      unsettledContributorCents: owed._sum.amountCents ?? 0,
      paidOutCents: paid._sum.amountCents ?? 0,
      payoutsCompleted: paid._count,
      exceptions,
      recentEvents: recent,
    });
  });

  r.get('/audit/public-key', (_req, res) => {
    res.type('text/plain').send(publicKeyPem(signingKeys()));
  });

  /** Incremental check for signed-in users; a full re-hash of the whole log is admin-only. */
  r.get('/audit/verify-chain', requireRole('publisher', 'contributor', 'buyer', 'admin'), async (req, res) => {
    const full = req.query.full === '1' && currentUser(req).role === 'admin';
    res.json(full ? await verifyAuditChain(db) : await verifyAuditChainCached(db));
  });

  return r;
}
