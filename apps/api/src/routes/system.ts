import { Router } from 'express';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/demo-auth';
import { verifyAuditChain } from '../modules/audit/audit-log';
import { publicKeyPem } from '../modules/audit/signing';
import { resetAndSeed } from '../modules/demo/seed';

export function systemRoutes({ db, config, signingKeys, writer, planner }: AppDeps) {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'tracepay-api', paypalEnv: 'sandbox' });
  });

  /** Public, non-secret configuration the web app needs at startup. */
  r.get('/config', (_req, res) => {
    res.json({
      paypalEnv: 'sandbox',
      paypalClientId: config.paypalClientId,
      generation: writer().name,
      agentPlanner: planner().name,
      vertexReady: config.vertexReady,
      demoMode: true,
    });
  });

  r.get('/demo/users', async (_req, res) => {
    const users = await db.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true, role: true, email: true } });
    res.json({ users });
  });

  r.get('/me', (req, res) => {
    res.json({ user: currentUser(req) });
  });

  /** Restores TracePay's fixtures. PayPal sandbox history is untouched. */
  r.post('/demo/reset', requireRole('publisher', 'admin'), async (_req, res) => {
    const result = await resetAndSeed(db);
    res.json({ ok: true, ...result, note: 'TracePay data reset. PayPal sandbox transactions are not reversed.' });
  });

  r.get('/dashboard', requireRole('publisher', 'admin'), async (_req, res) => {
    const [buildsPassed, buildsBlocked, artifacts, sales, owed, paid, exceptions, recent] = await Promise.all([
      db.buildJob.count({ where: { status: { in: ['preflight_passed', 'generating', 'generated'] } } }),
      db.buildJob.count({ where: { status: 'preflight_blocked' } }),
      db.artifact.count(),
      db.payPalPayment.aggregate({ where: { sale: { status: 'captured' } }, _count: true, _sum: { capturedCents: true } }),
      db.settlementLine.aggregate({
        where: { kind: 'contributor', payable: true, run: { status: { in: ['calculated', 'approved', 'payout_submitted'] } }, OR: [{ payoutItem: null }, { payoutItem: { status: { not: 'SUCCESS' } } }] },
        _sum: { amountCents: true },
      }),
      db.payoutItem.aggregate({ where: { status: 'SUCCESS' }, _sum: { amountCents: true }, _count: true }),
      db.settlementRun.count({ where: { status: 'exception' } }),
      db.auditEvent.findMany({ orderBy: { seq: 'desc' }, take: 12, select: { seq: true, eventType: true, entityType: true, entityId: true, createdAt: true, hash: true } }),
    ]);
    res.json({
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
