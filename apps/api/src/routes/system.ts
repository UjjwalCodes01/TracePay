import { Router } from 'express';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { HttpError } from '../http/errors';
import { verifyAuditChain } from '../modules/audit/audit-log';
import { publicKeyPem } from '../modules/audit/signing';
import { resetAndSeed } from '../modules/demo/seed';

export function systemRoutes({ db, config, signingKeys, writer, planner }: AppDeps) {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'tracepay-api', paypalEnv: 'sandbox' });
  });

  /** Readiness: the process is up AND can reach the database. */
  r.get('/ready', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ ok: true });
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
    });
  });

  r.get('/demo/users', async (_req, res) => {
    if (!config.demoMode) return res.json({ users: [] });
    const users = await db.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true, role: true, email: true } });
    res.json({ users });
  });

  /** Restores TracePay's fixtures. PayPal sandbox history is untouched. */
  r.post('/demo/reset', requireRole('publisher', 'admin'), async (req, res) => {
    if (!config.demoMode) throw new HttpError(404, 'Not found.');
    // Reset wipes every table, real accounts included: only demo roles and admins may trigger it.
    if (req.authMethod !== 'demo' && req.user?.role !== 'admin') throw new HttpError(403, 'Only demo users can reset the demo.');
    const result = await resetAndSeed(db);
    res.json({ ok: true, ...result, note: 'TracePay data reset. PayPal sandbox transactions are not reversed.' });
  });

  r.get('/dashboard', requireRole('publisher', 'admin'), async (req, res) => {
    const user = currentUser(req);
    // Everything below is scoped to this publisher; admins see the whole system.
    const mine = user.role === 'admin' ? {} : { publisherId: user.id };
    const mySale = user.role === 'admin' ? {} : { artifact: { buildJob: { publisherId: user.id } } };
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
        where: { eventType: { notIn: ['sale.created'] }, ...(user.role === 'admin' ? {} : { tenantId: user.id }) },
        orderBy: { seq: 'desc' },
        take: 12,
        select: { seq: true, eventType: true, entityType: true, entityId: true, createdAt: true, hash: true, payload: true },
      }),
      db.settlementRun.count({ where: { ...myRun, status: 'calculated' } }),
      db.settlementRun.count({ where: { ...myRun, status: 'approved' } }),
      db.settlementRun.count({ where: { ...myRun, status: 'payout_submitted' } }),
      db.agentRun.count({ where: { ...mine, status: 'awaiting_approval' } }),
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

  r.get('/audit/verify-chain', async (_req, res) => {
    res.json(await verifyAuditChain(db));
  });

  return r;
}
