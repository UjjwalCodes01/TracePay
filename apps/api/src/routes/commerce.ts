import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { currentUser, requireRole } from '../http/demo-auth';
import { HttpError } from '../http/errors';
import { captureSale, startCheckout } from '../modules/payments/payments.service';
import { handlePayPalWebhook, readVerificationHeaders } from '../modules/payments/webhooks.service';
import { approveSettlement, refreshPayouts, submitPayouts } from '../modules/settlements/settlement.service';

const param = (req: Request, name: string) => z.string().min(1).max(64).parse(req.params[name]);

export function commerceRoutes({ db, paypal, config }: AppDeps) {
  const r = Router();

  // ---- buyer checkout ----------------------------------------------------------

  r.post('/checkout/orders', requireRole('buyer'), async (req, res) => {
    const { artifactId } = z.object({ artifactId: z.string().min(1) }).parse(req.body);
    const started = await startCheckout(db, paypal(), { artifactId, buyerId: currentUser(req).id, appBaseUrl: config.appBaseUrl });
    res.status(201).json(started);
  });

  r.post('/checkout/:saleId/capture', requireRole('buyer'), async (req, res) => {
    const saleId = param(req, 'saleId');
    const sale = await db.sale.findUnique({ where: { id: saleId }, select: { buyerId: true } });
    if (!sale) throw new HttpError(404, 'Sale not found.');
    if (sale.buyerId !== currentUser(req).id) throw new HttpError(403, 'This is not your sale.');
    res.json(await captureSale(db, paypal(), saleId));
  });

  r.get('/sales', requireRole('publisher', 'admin', 'buyer'), async (req, res) => {
    const user = currentUser(req);
    const sales = await db.sale.findMany({
      where: user.role === 'buyer' ? { buyerId: user.id } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { payment: true, artifact: { select: { id: true, title: true } }, settlement: { select: { id: true, status: true } } },
    });
    res.json({ sales });
  });

  // ---- settlement console ------------------------------------------------------

  const settlementInclude = {
    lines: { include: { payoutItem: true }, orderBy: { amountCents: 'desc' as const } },
    batch: true,
    sale: { include: { payment: true, artifact: { select: { id: true, title: true, buildJobId: true } } } },
  };

  r.get('/settlements', requireRole('publisher', 'admin'), async (_req, res) => {
    const runs = await db.settlementRun.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: settlementInclude });
    res.json({ settlements: runs });
  });

  r.get('/settlements/:id', requireRole('publisher', 'admin'), async (req, res) => {
    const run = await db.settlementRun.findUnique({ where: { id: param(req, 'id') }, include: settlementInclude });
    if (!run) throw new HttpError(404, 'Settlement not found.');
    res.json({ settlement: run });
  });

  r.post('/settlements/:id/approve', requireRole('publisher'), async (req, res) => {
    res.json({ settlement: await approveSettlement(db, param(req, 'id'), currentUser(req).id) });
  });

  r.post('/settlements/:id/payouts', requireRole('publisher'), async (req, res) => {
    res.status(201).json({ batch: await submitPayouts(db, paypal(), param(req, 'id')) });
  });

  r.post('/settlements/:id/refresh', requireRole('publisher', 'admin'), async (req, res) => {
    res.json(await refreshPayouts(db, paypal(), param(req, 'id')));
  });

  // ---- contributor view: "every contributor gets a settlement record" -------------

  r.get('/contributor/earnings', requireRole('contributor'), async (req, res) => {
    const user = currentUser(req);
    const lines = await db.settlementLine.findMany({
      where: { recipientId: user.id, kind: 'contributor' },
      orderBy: { run: { createdAt: 'desc' } },
      include: { payoutItem: true, run: { include: { sale: { include: { artifact: { select: { id: true, title: true } }, payment: { select: { captureId: true } } } } } } },
    });
    const licenses = await db.licenseGrant.findMany({ where: { asset: { ownerId: user.id } }, include: { asset: { select: { title: true } } }, orderBy: { version: 'desc' } });
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
    res.status(result.status === 'rejected' ? 400 : 200).json(result);
  };
}
