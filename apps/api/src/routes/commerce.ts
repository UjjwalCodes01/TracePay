import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/auth';
import { ownedSettlement } from '../http/access';
import { HttpError } from '../http/errors';
import { quotas } from '../http/limits';
import { isDemoBuyer } from '../modules/answers/credits.service';
import { captureSale, startCheckout } from '../modules/payments/payments.service';
import { handlePayPalWebhook, readVerificationHeaders } from '../modules/payments/webhooks.service';
import { approveSettlement, recalculateSettlement, refreshPayouts, retryFailedPayouts, submitPayouts } from '../modules/settlements/settlement.service';

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);

export function commerceRoutes({ db, paypal, config }: AppDeps) {
  const r = Router();

  // ---- buyer checkout ----------------------------------------------------------

  r.post('/checkout/orders', requireRole('buyer'), quotas.checkout(), async (req, res) => {
    const { artifactId } = z.object({ artifactId: z.string().min(1) }).parse(req.body);
    const buyerId = currentUser(req).id;
    // A hosted demo's shared buyer can buy again, so every visitor can try PayPal checkout.
    const started = await startCheckout(db, paypal(), { artifactId, buyerId, appBaseUrl: config.appBaseUrl, allowRepeat: !!config.demoSharedBuyer && isDemoBuyer(buyerId) });
    res.status(201).json(started);
  });

  r.post('/checkout/:saleId/capture', requireRole('buyer'), async (req, res) => {
    const saleId = param(req, 'saleId');
    const sale = await db.sale.findUnique({ where: { id: saleId }, select: { buyerId: true } });
    // Same answer whether the sale doesn't exist or isn't yours.
    if (!sale || sale.buyerId !== currentUser(req).id) throw new HttpError(404, 'Sale not found.');
    res.json(await captureSale(db, paypal(), saleId));
  });

  r.get('/sales', requireRole('publisher', 'admin', 'buyer'), async (req, res) => {
    const user = currentUser(req);
    const sales = await db.sale.findMany({
      where: user.role === 'buyer' ? { buyerId: user.id } : user.role === 'admin' ? {} : { artifact: { buildJob: { publisherId: user.id } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      // Explicit fields: never the frozen terms (they hold every contributor's payout address) or raw PayPal payloads.
      select: {
        id: true, status: true, amountCents: true, currency: true, createdAt: true,
        artifact: { select: { id: true, title: true } },
        payment: { select: { orderId: true, captureId: true, captureStatus: true, capturedCents: true } },
        ...(user.role === 'buyer' ? {} : { settlement: { select: { id: true, status: true } } }),
      },
    });
    res.json({ sales });
  });

  // ---- settlement console ------------------------------------------------------

  // Explicit fields: never the buyer's PayPal email, raw PayPal payloads or the frozen terms snapshot.
  const settlementInclude = {
    lines: {
      include: { payoutItem: { select: { id: true, status: true, receiver: true, amountCents: true, paypalItemId: true, transactionId: true, errorName: true, senderItemId: true } } },
      orderBy: { amountCents: 'desc' as const },
    },
    batches: { orderBy: { attempt: 'desc' as const }, select: { id: true, attempt: true, senderBatchId: true, paypalBatchId: true, status: true, lastCheckedAt: true, createdAt: true } },
    sale: {
      select: {
        id: true, status: true, amountCents: true, currency: true, createdAt: true,
        payment: { select: { orderId: true, captureId: true, captureStatus: true, capturedCents: true, paypalFeeCents: true } },
        artifact: { select: { id: true, title: true, buildJobId: true } },
      },
    },
  };

  /** Adds each line's recipient name and source title, for people who don't know ids. */
  const withNames = async <T extends { lines: Array<{ recipientId: string; assetVersionId: string | null }> }>(runs: T[]) => {
    const ids = [...new Set(runs.flatMap((r) => r.lines.map((l) => l.recipientId)))];
    const versionIds = [...new Set(runs.flatMap((r) => r.lines.flatMap((l) => (l.assetVersionId ? [l.assetVersionId] : []))))];
    const [users, versions] = await Promise.all([
      ids.length ? db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [],
      versionIds.length ? db.assetVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, asset: { select: { title: true } } } }) : [],
    ]);
    const names = new Map(users.map((u) => [u.id, u.name]));
    const titles = new Map(versions.map((v) => [v.id, v.asset.title]));
    return runs.map((r) => ({
      ...r,
      lines: r.lines.map((l) => ({ ...l, recipientName: names.get(l.recipientId) ?? null, sourceTitle: l.assetVersionId ? (titles.get(l.assetVersionId) ?? null) : null })),
    }));
  };

  r.get('/settlements', requireRole('publisher', 'admin'), async (req, res) => {
    const user = currentUser(req);
    const runs = await db.settlementRun.findMany({
      where: user.role === 'admin' ? {} : { sale: { artifact: { buildJob: { publisherId: user.id } } } },
      orderBy: { createdAt: 'desc' }, take: 100, include: settlementInclude });
    res.json({ settlements: await withNames(runs) });
  });

  r.get('/settlements/:id', requireRole('publisher', 'admin'), async (req, res) => {
    const { id } = await ownedSettlement(db, currentUser(req), param(req, 'id'));
    const run = await db.settlementRun.findUniqueOrThrow({ where: { id }, include: settlementInclude });
    res.json({ settlement: (await withNames([run]))[0] });
  });

  r.post('/settlements/:id/approve', requireRole('publisher'), async (req, res) => {
    const { id } = await ownedSettlement(db, currentUser(req), param(req, 'id'));
    res.json({ settlement: await approveSettlement(db, id, currentUser(req).id) });
  });

  r.post('/settlements/:id/payouts', requireRole('publisher'), async (req, res) => {
    const { id } = await ownedSettlement(db, currentUser(req), param(req, 'id'));
    res.status(201).json({ batch: await submitPayouts(db, paypal(), id) });
  });

  r.post('/settlements/:id/refresh', requireRole('publisher', 'admin'), async (req, res) => {
    const { id } = await ownedSettlement(db, currentUser(req), param(req, 'id'));
    res.json(await refreshPayouts(db, paypal(), id));
  });

  /** Re-send only the payouts PayPal reported as failed or returned, to contributors' current addresses. */
  r.post('/settlements/:id/retry-failed', requireRole('publisher'), async (req, res) => {
    const { id } = await ownedSettlement(db, currentUser(req), param(req, 'id'));
    res.status(201).json({ batch: await retryFailedPayouts(db, paypal(), id) });
  });

  /** Recalculate a settlement whose calculation failed, once the cause is fixed. */
  r.post('/settlements/:id/recalculate', requireRole('publisher'), async (req, res) => {
    const { id } = await ownedSettlement(db, currentUser(req), param(req, 'id'));
    res.json({ settlement: await recalculateSettlement(db, id) });
  });

  // ---- contributor view: "every contributor gets a settlement record" -------------

  r.get('/contributor/earnings', requireRole('contributor'), async (req, res) => {
    const user = currentUser(req);
    const lines = await db.settlementLine.findMany({
      where: { recipientId: user.id, kind: 'contributor' },
      orderBy: { run: { createdAt: 'desc' } },
      take: 200,
      select: {
        id: true, amountCents: true, formula: true, payable: true, note: true, licenseGrantId: true,
        payoutItem: { select: { status: true, receiver: true, transactionId: true, paypalItemId: true } },
        run: { select: { status: true, createdAt: true, sale: { select: { id: true, artifact: { select: { id: true, title: true } }, payment: { select: { captureId: true } } } } } },
      },
    });
    const licenses = await db.licenseGrant.findMany({
      where: { asset: { ownerId: user.id } },
      orderBy: { version: 'desc' },
      take: 200,
      select: { id: true, version: true, status: true, terms: true, asset: { select: { title: true } } },
    });
    res.json({ lines, licenses });
  });

  return r;
}

/** PayPal webhook endpoint. Always 200 for recognised-but-ignored events so PayPal stops retrying. */
export function webhookRoute({ db, paypal, config }: AppDeps): RequestHandler {
  return async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const result = await handlePayPalWebhook(db, paypal(), {
      webhookId: config.paypalWebhookId,
      headers: readVerificationHeaders((n) => req.header(n)),
      rawBody,
    });
    // 500 on a failed apply so PayPal redelivers; never echo internal error text to the caller.
    if (result.status === 'failed') return res.status(500).json({ status: 'failed', eventId: result.eventId });
    res.status(result.status === 'rejected' ? 400 : 200).json(result);
  };
}
